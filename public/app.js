/**
 * Файлообменник — клиентская логика.
 * Роутер /  и  /f/:id , загрузка с прогрессом, копирование ссылок, тема.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Адрес API. Фронт живёт на GitHub Pages, API — на отдельном Worker'е,
 * поэтому все запросы строятся отсюда. Если адрес совпадает с текущим
 * доменом (сайт отдаёт сам Worker), используем относительные пути —
 * так не тратится CORS и не нужен лишний origin в CSP.
 */
const CONFIGURED_API = String(window.FILEX?.apiBase || '').replace(/\/+$/, '');
const API_BASE = CONFIGURED_API === location.origin ? '' : CONFIGURED_API;
const apiUrl = (path) => `${API_BASE}${path}`;

const state = {
  stats: null,
  ttl: 24,
  once: false,
  owners: loadJSON('fo:owners', {}),
  token: localStorage.getItem('fo:token') || '',
  user: null,
  authMode: 'login',
  activeUploads: 0,
};

/* ----------------------------- утилиты ----------------------------- */

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* приватный режим — не страшно */
  }
}

function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

function dateTime(ts) {
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function timeLeft(expiresAt) {
  if (!expiresAt) return 'бессрочно';
  const diff = expiresAt - Date.now();
  if (diff <= 0) return 'срок истёк';
  const mins = Math.floor(diff / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days >= 1) return `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
  if (hours >= 1) return `${hours} ${plural(hours, ['час', 'часа', 'часов'])}`;
  return `${Math.max(mins, 1)} ${plural(mins, ['минута', 'минуты', 'минут'])}`;
}

function randomToken() {
  const bytesArr = crypto.getRandomValues(new Uint8Array(24));
  return [...bytesArr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Публичная ссылка на файл. Hash-роутинг (#/f/<id>) нужен потому, что
 * GitHub Pages не умеет отдавать SPA по произвольным путям.
 */
function shareUrl(id) {
  return `${location.origin}${location.pathname}#/f/${id}`;
}

function icon(id, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (className) svg.setAttribute('class', className);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function button(label, iconId, className = 'btn btn-sm') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.append(icon(iconId), document.createTextNode(label));
  return btn;
}

/**
 * Запрос к API. Объект в body превращаем в JSON сами: иначе он уедет как
 * «[object Object]», сервер его не разберёт, а человек увидит ошибку в
 * пустом месте.
 */
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  // Сессия живёт в localStorage и передаётся заголовком: так работает и когда
  // фронт на GitHub Pages, а API на другом домене (куки там были бы third-party).
  if (state.token) headers.authorization = `Bearer ${state.token}`;

  const init = { cache: 'no-store', ...options, headers };
  if (init.body && typeof init.body === 'object' && !(init.body instanceof FormData) && !(init.body instanceof Blob) && !(init.body instanceof ArrayBuffer) && !ArrayBuffer.isView(init.body)) {
    init.body = JSON.stringify(init.body);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  }

  const res = await fetch(apiUrl(path), init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* не JSON */
  }
  if (!res.ok) {
    const message = data?.error?.message || `Ошибка ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

/* ------------------------------ Тосты ------------------------------ */

/**
 * Уведомление справа. Прогресс загрузки идёт сюда же — отдельных панелей
 * в карточке больше нет. Один и тот же текст подряд не дублируем, а
 * сообщения одного файла заменяют друг друга, чтобы не сыпать десяток строк.
 */
const toastState = { last: '', at: 0 };

function toast(message, kind = 'info', ttl = 4200) {
  const host = $('#toasts');
  if (!host) return;

  // Тот же текст подряд — не плодим дубликаты.
  const now = Date.now();
  if (message === toastState.last && now - toastState.at < 1500) return;
  toastState.last = message;
  toastState.at = now;

  // Сообщения одного файла: пока идёт его загрузка, старое заменяем новым.
  const fresh = document.createElement('div');
  fresh.className = 'toast';
  fresh.dataset.kind = kind;
  fresh.append(icon(kind === 'ok' ? 'i-check' : kind === 'err' ? 'i-x' : 'i-bolt'), document.createTextNode(message));
  host.append(fresh);

  let gone = false;
  const hide = () => {
    if (gone) return;
    gone = true;
    fresh.classList.add('out');
    fresh.addEventListener('animationend', () => fresh.remove(), { once: true });
  };
  setTimeout(hide, ttl);

  // Прогресс одного файла не копится: убираем прошлое сообщение о нём же.
  const [name] = message.split(':');
  if (name && name.length < 60) {
    for (const other of host.querySelectorAll('.toast')) {
      if (other !== fresh && other.textContent.startsWith(name)) {
        other.remove();
      }
    }
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // запасной путь для http и старых браузеров
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/* --------------------------- Авторизация --------------------------- */

function setSession(token, user) {
  state.token = token || '';
  state.user = user || null;
  if (state.token) localStorage.setItem('fo:token', state.token);
  else localStorage.removeItem('fo:token');
  renderAuth();
  // Подсказка в форме зависит от того, вошёл ли пользователь
  if (state.stats) renderUploadHint(state.stats);
  // Сроки ссылок зависят от подписки — обновляем их после входа и выхода
  loadBilling().then(() => {
    renderSubscription();
    if (state.stats) renderUploadHint(state.stats);
  });
}

function renderAuth() {
  const logged = !!state.user;
  $('#authBox').hidden = logged;
  $('#profileBox').hidden = !logged;
  if (!logged) return;

  const letter = (state.user.username || 'Ф').trim().charAt(0).toUpperCase();
  $('#avatarLetter').textContent = letter;
  $('#avatarLetterBig').textContent = letter;
  $('#profileName').textContent = state.user.username;
  $('#menuName').textContent = state.user.username;
  $('#menuSince').textContent = state.user.createdAt ? `с ${dateTime(state.user.createdAt)}` : 'в файлообменнике';
}

async function loadProfile() {
  if (!state.token) {
    setSession('', null);
    return null;
  }
  try {
    const data = await api('/api/auth/me');
    setSession(state.token, data.user);
    return data;
  } catch (err) {
    // Токен протух или был удалён — выходим молча
    if (err.status === 401) setSession('', null);
    return null;
  }
}

function openAuthModal(mode = 'login') {
  state.authMode = mode;
  $('#authError').hidden = true;
  $('#authForm').reset();
  applyAuthMode();
  $('#authModal').hidden = false;
  lockScroll(true);
  setTimeout(() => $('#loginInput').focus(), 60);
}

function closeAuthModal() {
  $('#authModal').hidden = true;
  $('#authForm').reset();
  lockScroll(false);
}

function applyAuthMode() {
  const isLogin = state.authMode === 'login';
  $('#authTitle').textContent = isLogin ? 'Вход в файлообменник' : 'Регистрация';
  $('#authSub').textContent = isLogin
    ? 'Войди, чтобы видеть свои файлы в кабинете'
    : 'Придумай логин и пароль — кабинет создастся сразу';
  $('#authSubmitText').textContent = isLogin ? 'Войти' : 'Создать аккаунт';
  $('#passwordInput').autocomplete = isLogin ? 'current-password' : 'new-password';
  $$('[data-auth-tab]').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.authTab === state.authMode)));
}

async function submitAuth(event) {
  event.preventDefault();
  const btn = $('#authSubmit');
  const errorBox = $('#authError');
  const login = $('#loginInput').value.trim();
  const password = $('#passwordInput').value;

  btn.disabled = true;
  errorBox.hidden = true;

  try {
    const data = await api(`/api/auth/${state.authMode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, password }),
    });
    setSession(data.token, data.user);
    closeAuthModal();
    toast(state.authMode === 'login' ? `С возвращением, ${data.user.username}` : `Аккаунт ${data.user.username} создан`, 'ok');
    if (location.hash.startsWith('#/profile')) renderProfile();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* даже если сервер ответил ошибкой — вычищаем локально */
  }
  setSession('', null);
  $('#profileMenu').hidden = true;
  toast('Вы вышли из аккаунта', 'info');
  if (location.hash.startsWith('#/profile')) {
    history.pushState({}, '', '#/');
    route();
  }
}

function initAuth() {
  $('#loginBtn').addEventListener('click', () => openAuthModal('login'));
  $('#registerBtn').addEventListener('click', () => openAuthModal('register'));

  $('#authClose').addEventListener('click', closeAuthModal);
  $('#authModal').addEventListener('click', (e) => {
    if (e.target.dataset.close !== undefined) closeAuthModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#authModal').hidden) closeAuthModal();
  });

  $$('[data-auth-tab]').forEach((tab) =>
    tab.addEventListener('click', () => {
      state.authMode = tab.dataset.authTab;
      $('#authError').hidden = true;
      applyAuthMode();
    }),
  );

  $('#authForm').addEventListener('submit', submitAuth);
  $('#logoutBtn').addEventListener('click', logout);
  $('#profLogout').addEventListener('click', logout);

  const menu = $('#profileMenu');
  $('#profileTrigger').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    $('#profileTrigger').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('#profileBox')) menu.hidden = true;
  });
}

/* ------------------------- Личный кабинет -------------------------- */

function fileRow(file, { onDelete = null, badge = null } = {}) {
  const li = document.createElement('li');
  li.className = 'file-row';

  const iconBox = document.createElement('span');
  iconBox.className = 'q-icon';
  iconBox.append(icon('i-file'));

  const body = document.createElement('div');
  body.className = 'q-body';
  const name = document.createElement('div');
  name.className = 'q-name';
  name.textContent = file.name;
  const sub = document.createElement('div');
  sub.className = 'q-sub';
  const bits = [bytes(file.size), dateTime(file.createdAt)];
  if (file.ttlPending) bits.push('срок не выбран');
  else if (file.expiresAt) bits.push(`удалится ${timeLeft(file.expiresAt)}`);
  if (file.once) bits.push('одноразовая');
  if (file.expired) bits.push('срок истёк');
  if (badge) bits.push(badge);
  sub.textContent = bits.join(' · ');
  body.append(name, sub);

  const actions = document.createElement('div');
  actions.className = 'q-actions';

  // Файл загружен, но срок не выбран: ссылки пока нет, предлагаем выбрать.
  if (file.ttlPending) {
    const wrap = document.createElement('div');
    wrap.className = 'q-ttl';
    const create = async ({ hours, once }) => {
      try {
        await api(`/api/file/${file.id}/link`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hours, once }),
        });
        toast('Ссылка создана', 'ok');
      } catch (err) {
        toast(err.message || 'Не удалось создать ссылку', 'err');
      }
      await loadBilling();
      renderProfile();
      loadStats();
    };
    wrap.append(linkOptions(create));
    actions.append(wrap);
  }

  // Созданную ссылку можно пережать по сроку — пока это позволяет подписка.
  if (!file.ttlPending && state.billing?.ttl?.selectable) {
    const edit = button('Срок', 'i-timer', 'btn btn-sm');
    edit.addEventListener('click', () => {
      const wrap = document.createElement('div');
      wrap.className = 'q-ttl';
      const save = async ({ hours }) => {
        try {
          await api(`/api/file/${file.id}/link`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hours }),
          });
          toast('Срок изменён', 'ok');
        } catch (err) {
          toast(err.message || 'Не удалось изменить срок', 'err');
        }
        renderProfile();
        loadStats();
      };
      wrap.append(linkOptions(save));
      // В форме правки срока переключатель «одноразовая» не нужен.
      const onceBox = wrap.querySelector('.q-ttl-once');
      if (onceBox) onceBox.remove();
      const label = wrap.querySelector('.q-ttl-label');
      if (label) label.textContent = 'новый срок';
      const create = wrap.querySelector('.btn');
      if (create) create.textContent = 'Сохранить срок';
      actions.replaceChildren(wrap);
    });
    actions.append(edit);
  }

  const copy = button('Копировать', 'i-copy');
  copy.hidden = !!file.ttlPending;
  copy.addEventListener('click', async () => {
    const ok = await copyText(shareUrl(file.id));
    toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать', ok ? 'ok' : 'err');
  });
  actions.append(copy);

  if (onDelete) {
    const del = button('Удалить', 'i-trash-sm', 'btn btn-sm btn-danger');
    del.addEventListener('click', async () => {
      if (!confirm(`Удалить «${file.name}»?`)) return;
      del.disabled = true;
      try {
        await onDelete(file);
        // Строку убираем сразу: список не должен ждать серверный ответ.
        li.remove();
        toast('Файл удалён', 'ok');
      } catch (err) {
        del.disabled = false;
        toast(err.message, 'err');
      }
    });
    actions.append(del);
  }

  li.append(iconBox, body, actions);
  return li;
}

function selectProfileTab(name) {
  $$('[data-profile-tab]').forEach((tab) =>
    tab.setAttribute('aria-selected', String(tab.dataset.profileTab === name)),
  );
  $$('[data-profile-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.profilePane !== name;
  });
  if (name === 'admin') loadAdminPanel();
}

async function renderProfile() {
  const [data] = await Promise.all([loadProfile(), loadBilling()]);
  if (!data) {
    openAuthModal('login');
    history.pushState({}, '', '#/');
    route();
    return;
  }

  renderSubscription();

  const letter = (data.user.username || 'Ф').trim().charAt(0).toUpperCase();
  $('#profAvatar').textContent = letter;
  $('#profName').textContent = data.user.username;
  $('#profSince').textContent = data.user.createdAt ? `В файлообменнике с ${dateTime(data.user.createdAt)}` : '—';
  $('#profFiles').textContent = String(data.totals.files);
  $('#profSize').textContent = bytes(data.totals.bytes);
  $('#menuFiles').textContent = String(data.totals.files);
  $('#menuSize').textContent = bytes(data.totals.bytes);

  $('#adminTab').hidden = !data.user.isAdmin;
  $('#anonNote').hidden = true;

  const list = $('#myFiles');
  list.replaceChildren();
  $('#myFilesEmpty').hidden = data.files.length > 0;
  for (const file of data.files) {
    list.append(
      fileRow(file, {
        onDelete: async (f) => {
          await api(`/api/file/${f.id}`, { method: 'DELETE' });
          renderProfile();
        },
      }),
    );
  }

  selectProfileTab($('#adminTab').hidden ? 'files' : 'files');
}

/* ----------------------- панель управления ------------------------- */

function jsonBody(payload) {
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

async function loadAdminPanel() {
  try {
    const [overview, settingsData] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/settings'),
    ]);

    const s = settingsData.settings;
    $('#setHeroTitle').value = String(s.heroTitle || '').replace(/\n/g, ' ');
    $('#setHeroLede').value = s.heroLede || '';
    $('#setMaxMb').value = s.maxFileSizeMb;
    $('#setMaxFiles').value = s.maxFilesPerUpload;
    $('#setTtl').value = s.defaultTtlHours;
    $('#setAnonTtl').value = s.anonymousTtlHours ?? 1;
    $('#setRegistration').checked = !!s.allowRegistration;
    $('#setMaintenance').checked = !!s.maintenance;
    setLineColorField(s.lineColor);

    // Подписка и оплата
    $('#setSubEnabled').checked = !!s.subEnabled;
    $('#setSubPrice').value = s.subPriceRub ?? 0;
    $('#setSubPeriod').value = s.subPeriodDays ?? 30;
    $('#setSubMaxTtl').value = s.subMaxTtlDays ?? 30;
    $('#setSubFreeTtl').value = s.subFreeTtlHours ?? 24;
    $('#setSubProvider').value = s.subProvider || 'manual';
    const providerInfo = state.billing?.subscription;
    const hint = $('#subProviderHint');
    if (hint && providerInfo) {
      const label = providerInfo.providers?.find((p) => p.id === (s.subProvider || 'manual'))?.label || '';
      hint.textContent = providerInfo.provider === 'manual'
        ? 'Пока выбрано «вручную» — сайт работает, подписку выдаёшь ты. Онлайн-оплату можно включить позже.'
        : providerInfo.ready
          ? `Выбрано: ${label}. Оплата идёт на странице сайта, статус подтверждаем сами.`
          : `Выбрано: ${label}. Не хватает секретов провайдера — добавь их в секреты Worker'а, пока работает ручная выдача.`;
    }
    const note = $('#subPayNote');
    if (note && state.billing?.subscription?.paymentConfigured === false) {
      note.textContent =
        'Оплата идёт через CloudPayments. Сейчас терминал не подключён: добавь Public ID и API Secret ' +
        'как секреты Worker\'а (CLOUDPAYMENTS_PUBLIC_ID, CLOUDPAYMENTS_SECRET_KEY) — до этого работает только ручная выдача.';
    }

    const cards = [
      ['Файлов', overview.counts.files],
      ['Пользователей', overview.counts.users],
      ['Сессий', overview.counts.sessions],
      ['Записей', overview.counts.notes ?? 0],
      ['Объём', bytes(overview.counts.bytes)],
      ['Хранилище', overview.storage.degraded ? 'аварийный режим' : 'в облаке'],
    ];
    const grid = $('#adminStats');
    grid.replaceChildren();
    for (const [label, value] of cards) {
      const cell = document.createElement('div');
      cell.className = 'stat';
      const b = document.createElement('span');
      b.className = 'stat-value';
      b.textContent = String(value);
      const small = document.createElement('span');
      small.className = 'stat-label';
      small.textContent = label;
      cell.append(b, small);
      grid.append(cell);
    }

    const list = $('#adminFiles');
    list.replaceChildren();
    if (!overview.recent.length) {
      const empty = document.createElement('li');
      empty.className = 'muted empty-note';
      empty.textContent = 'Файлов пока нет';
      list.append(empty);
    }
    for (const file of overview.recent) {
      list.append(
        fileRow(file, {
          badge: file.userId ? 'из аккаунта' : 'анонимно',
          onDelete: async (f) => {
            await api(`/api/admin/files/${f.id}`, { method: 'DELETE' });
            loadAdminPanel();
          },
        }),
      );
    }

    await loadNotes();
    await loadContacts();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------- данные сайта ---------------------------- */

let editingNote = null;

async function loadNotes() {
  try {
    const { notes } = await api('/api/admin/notes');
    const list = $('#noteList');
    list.replaceChildren();

    if (!notes.length) {
      const empty = document.createElement('li');
      empty.className = 'muted empty-note';
      empty.textContent = 'Записей пока нет';
      list.append(empty);
      return;
    }

    for (const note of notes) {
      const li = document.createElement('li');
      li.className = 'note-card';

      const head = document.createElement('div');
      head.className = 'note-head';
      const title = document.createElement('strong');
      title.textContent = note.title;
      const time = document.createElement('small');
      time.className = 'muted';
      time.textContent = dateTime(note.updatedAt);
      head.append(title, time);

      const text = document.createElement('p');
      text.className = 'note-text';
      text.textContent = note.text;

      const actions = document.createElement('div');
      actions.className = 'q-actions';

      const edit = button('Изменить', 'i-copy');
      edit.addEventListener('click', () => {
        editingNote = note;
        $('#noteTitle').value = note.title;
        $('#noteText').value = note.text;
        $('#noteSubmitText').textContent = 'Сохранить изменения';
        $('#noteCancel').hidden = false;
        $('#noteForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      const del = button('Удалить', 'i-trash-sm', 'btn btn-sm btn-danger');
      del.addEventListener('click', async () => {
        if (!confirm(`Удалить запись «${note.title}»?`)) return;
        try {
          await api(`/api/admin/notes/${note.id}`, { method: 'DELETE' });
          toast('Запись удалена', 'ok');
          loadNotes();
        } catch (err) {
          toast(err.message, 'err');
        }
      });

      actions.append(edit, del);
      li.append(head, text, actions);
      list.append(li);
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

function resetNoteForm() {
  editingNote = null;
  $('#noteForm').reset();
  $('#noteSubmitText').textContent = 'Сохранить запись';
  $('#noteCancel').hidden = true;
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        heroTitle: $('#setHeroTitle').value.replace(/\n/g, ' '),
        heroLede: $('#setHeroLede').value,
        maxFileSizeMb: Number($('#setMaxMb').value),
        maxFilesPerUpload: Number($('#setMaxFiles').value),
        defaultTtlHours: Number($('#setTtl').value),
        anonymousTtlHours: Number($('#setAnonTtl').value),
        allowRegistration: $('#setRegistration').checked,
        maintenance: $('#setMaintenance').checked,
        lineColor: $('#setLineColor').value,
        subEnabled: $('#setSubEnabled').checked,
        subPriceRub: Number($('#setSubPrice').value),
        subPeriodDays: Number($('#setSubPeriod').value),
        subMaxTtlDays: Number($('#setSubMaxTtl').value),
        subFreeTtlHours: Number($('#setSubFreeTtl').value),
        subProvider: $('#setSubProvider').value,
      }),
    });
    toast('Настройки сохранены', 'ok');
    await loadBilling();
    renderSubscription();
    loadStats();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** Образцы цвета: клик — сразу примеряем обводку, без сохранения. */
function initLinePicker() {
  const input = $('#setLineColor');
  if (!input) return;

  input.addEventListener('input', () => {
    applyLineColor(input.value);
    for (const swatch of document.querySelectorAll('.line-swatch')) {
      swatch.classList.toggle('is-active', swatch.dataset.line === input.value.toLowerCase());
    }
  });

  for (const swatch of document.querySelectorAll('.line-swatch')) {
    swatch.addEventListener('click', () => setLineColorField(swatch.dataset.line));
  }
}

function initAdmin() {
  initLinePicker();
  $('#adminForm').addEventListener('submit', saveSettings);
  $('#subBuyBtn').addEventListener('click', buySubscription);

  // Ручная выдача подписки: на случай, пока терминал не подключён.
  $('#subGrantBtn').addEventListener('click', async () => {
    const login = $('#subGrantLogin').value.trim();
    if (!login) return toast('Впиши логин', 'err');
    try {
      const res = await api('/api/admin/subscription', {
        method: 'PUT',
        body: JSON.stringify({ login, days: Number($('#subGrantDays').value) || undefined }),
      });
      toast(`Подписка выдана до ${dateTime(res.subscription.expiresAt)}. Файлов восстановлено: ${res.restored || 0}`, 'ok');
      $('#subGrantLogin').value = '';
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#subRevokeBtn').addEventListener('click', async () => {
    const login = $('#subGrantLogin').value.trim();
    if (!login) return toast('Впиши логин', 'err');
    try {
      const res = await api('/api/admin/subscription', { method: 'PUT', body: JSON.stringify({ login, revoke: true }) });
      toast(`Подписка отозвана. Срок файлов срезан: ${res.files || 0}`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#contactForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#contactTitle').value.trim();
    const value = $('#contactValue').value.trim();
    const kind = $('#contactKind').value;
    const copyOnClick = $('#contactCopy').checked;
    if (!title || !value) return toast('Заполни название и значение', 'err');

    try {
      await api('/api/admin/contacts', { method: 'POST', body: { title, value, kind, copyOnClick } });
      $('#contactTitle').value = '';
      $('#contactValue').value = '';
      $('#contactCopy').checked = false;
      toast('Контакт добавлен', 'ok');
      await loadContacts();
      loadStats();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#noteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = { title: $('#noteTitle').value.trim(), text: $('#noteText').value };
    try {
      if (editingNote) await api(`/api/admin/notes/${editingNote.id}`, { method: 'PUT', ...jsonBody(payload) });
      else await api('/api/admin/notes', { method: 'POST', ...jsonBody(payload) });
      toast(editingNote ? 'Запись обновлена' : 'Запись сохранена', 'ok');
      resetNoteForm();
      loadNotes();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#noteCancel').addEventListener('click', resetNoteForm);

  $('#cleanupBtn').addEventListener('click', async () => {
    if (!confirm('Удалить все просроченные файлы и старые сессии?')) return;
    try {
      const res = await api('/api/admin/cleanup', { method: 'POST' });
      toast(`Убрано записей: ${res.removed}`, 'ok');
      loadAdminPanel();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $$('[data-profile-tab]').forEach((tab) =>
    tab.addEventListener('click', () => selectProfileTab(tab.dataset.profileTab)),
  );
}

/* ------------------------------- Тема ------------------------------- */

function initTheme() {
  const saved = localStorage.getItem('fo:theme');
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = saved || (prefersLight ? 'light' : 'dark');

  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('fo:theme', next);
    // Цвет текста и иконок зависит от темы: на светлом он притемняется.
    applyLineColor(state.stats?.settings?.lineColor);
  });
}

/* --------------------------- Статистика ---------------------------- */

async function loadStats() {
  try {
    const stats = await api('/api/stats');
    state.stats = stats;

    applyLineColor(stats.settings?.lineColor);
    $('#statFiles').textContent = stats.listed ? String(stats.files) : '—';
    $('#statToday').textContent = Number.isFinite(stats.filesToday) ? String(stats.filesToday) : '—';
    renderContacts(stats.contacts);
    const year = $('#copyYear');
    if (year) year.textContent = String(new Date().getFullYear());
    $('#statSize').textContent = `${stats.maxFileSizeMb} МБ`;
    $('#statBackend').textContent = stats.storage.degraded ? 'в памяти' : 'в облаке';
    $('#limitsHint').textContent = `До ${stats.maxFileSizeMb} МБ на файл · до ${stats.maxFiles ?? 4} файлов за раз`;

    // Тексты и режимы приходят из панели управления
    if (stats.settings) {
      const title = String(stats.settings.heroTitle || '').split('\n').filter(Boolean);
      if (title.length) {
        $('#heroLine1').textContent = title[0];
        $('#heroLine2').textContent = title.slice(1).join(' ');
      }
      $('#heroLede').textContent = stats.settings.heroLede || '';
      state.registrationOpen = stats.settings.allowRegistration !== false;
      setMaintenance(!!stats.settings.maintenance);
    }

    renderStoragePill(stats.storage);
    renderUploadHint(stats);
    renderStorageNotice(stats.storage);
  } catch {
    $('#statFiles').textContent = '—';
    $('#statToday').textContent = '—';
    renderStoragePill({ degraded: true, provider: 'offline' });
  }
}

/**
 * Технические работы: баннер на всех страницах, а форма загрузки перестаёт
 * принимать файлы — вместо зоны перетаскивания показываем заглушку.
 */
function setMaintenance(on) {
  state.maintenance = !!on;
  document.body.classList.toggle('is-maint', state.maintenance);

  const banner = $('#maintBanner');
  if (banner) banner.hidden = !state.maintenance;

  const zone = $('#dropzone');
  if (zone) {
    zone.hidden = state.maintenance;
    zone.setAttribute('aria-disabled', String(state.maintenance));
  }
  const block = $('#maintBlock');
  if (block) block.hidden = !state.maintenance;

  const input = $('#fileInput');
  if (input) input.disabled = state.maintenance;
}

/**
 * Шаг после загрузки: выбираем срок жизни и одноразовость, затем появляется
 * ссылка. Набор сроков приходит с сервера — он зависит от подписки.
 */
function linkOptions(create) {
  const wrap = document.createElement('div');
  wrap.className = 'q-ttl';

  const options = state.billing?.ttl?.options?.length
    ? state.billing.ttl.options
    : state.stats?.ttlOptions || [{ hours: 24, label: '24 часа' }];

  const label = document.createElement('span');
  label.className = 'q-ttl-label';
  label.textContent = options.length > 1 ? 'срок жизни' : 'срок ссылки';
  wrap.append(label);

  let hours = Number(options[0]?.hours ?? 24);
  let once = false;

  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'q-ttl-btn';
    btn.textContent = opt.label;
    btn.setAttribute('aria-pressed', String(hours === opt.hours));
    btn.addEventListener('click', () => {
      hours = opt.hours;
      for (const other of wrap.querySelectorAll('.q-ttl-btn')) {
        other.setAttribute('aria-pressed', String(other === btn));
      }
    });
    wrap.append(btn);
  }

  wrap.append(onceToggle((value) => {
    once = value;
  }));

  const go = button('Создать ссылку', 'i-link');
  go.addEventListener('click', () => create({ hours, once }));
  wrap.append(go);

  return wrap;
}

/** Переключатель одноразовой ссылки для шага «создать ссылку». */
function onceToggle(onChange, initial = false) {
  const label = document.createElement('label');
  label.className = 'q-ttl-once';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = initial;
  box.addEventListener('change', () => onChange(box.checked));
  const text = document.createElement('span');
  text.textContent = 'одноразовая';
  label.append(box, text);
  return label;
}

/**
 * Состояние подписки. Сервер сам решает, какие сроки доступны, поэтому клиент
 * не придумывает правила, а показывает то, что пришло.
 */
async function loadBilling() {
  if (!state.user) {
    state.billing = null;
    return null;
  }
  try {
    state.billing = await api('/api/billing/status');
  } catch {
    state.billing = null;
  }
  return state.billing;
}

function renderSubscription() {
  const card = $('#subCard');
  if (!card) return;
  if (!state.user) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const sub = state.billing?.subscription;
  const ttl = state.billing?.ttl;
  if (!sub) {
    $('#subBadge').textContent = 'Подписка';
    $('#subTitle').textContent = 'Срок ссылки — 24 часа';
    $('#subText').textContent = 'С подпиской срок выбираешь сам — до 30 дней на файл.';
    $('#subBuyBtn').hidden = false;
    $('#subBuyBtn').textContent = 'Оплатить подписку';
    return;
  }

  const maxDays = sub.maxTtlDays || 30;
  const buyable = sub.enabled && sub.provider !== 'manual' && sub.ready;
  if (sub.active) {
    $('#subBadge').textContent = 'Подписка активна';
    $('#subBadge').dataset.state = 'ok';
    $('#subTitle').textContent = `Срок ссылки — до ${maxDays} дней`;
    $('#subText').textContent = `Подписка действует до ${dateTime(sub.expiresAt)}. Сроки выбираешь сам, не больше ${maxDays} дней.`;
    $('#subBuyBtn').hidden = !buyable;
    $('#subBuyBtn').textContent = 'Продлить';
  } else {
    $('#subBadge').textContent = 'Без подписки';
    $('#subBadge').dataset.state = 'off';
    $('#subTitle').textContent = `Срок ссылки — ${ttl?.options?.[0]?.label || '24 часа'}`;
    $('#subText').textContent = sub.enabled && sub.provider === 'manual'
      ? `Онлайн-оплата выключена: подписку выдаёт администратор. С ней доступно до ${maxDays} дней.`
      : `Подписка открывает выбор срока: до ${maxDays} дней на файл.`;
    $('#subBuyBtn').hidden = !buyable;
  }
}
/**
 * Оплата подписки. Страница оплаты живёт внутри сайта: QR и ссылка
 * показываются здесь же, а статус спрашиваем сами — так не нужно уводить
 * человека к платёжной системе.
 */
let payTimer = null;

function payShow(name) {
  for (const key of ['Loading', 'QrBlock', 'Error', 'Success']) {
    const box = $(`#pay${key}`);
    if (box) box.hidden = key.toLowerCase() !== name.toLowerCase();
  }
}

function payStop() {
  if (payTimer) clearInterval(payTimer);
  payTimer = null;
}

function payStage(title, text) {
  $('#payStageTitle').textContent = title;
  $('#payStageText').textContent = text;
}

function payFail(message) {
  payStage('Нужна повторная попытка', 'Платёж не подготовлен');
  $('#payErrorText').textContent = message || 'Попробуй ещё раз.';
  payShow('Error');
}

/** Рисуем QR: картинка от провайдера либо сами по строке реквизитов. */
function payShowQr(data) {
  const image = $('#payQrImage');
  const text = $('#payQrText');
  const qr = data.qrImage || data.qr;

  if (data.qrImage) {
    image.src = data.qrImage;
    image.hidden = false;
  } else if (qr) {
    image.src = qrPayload(qr);
    image.hidden = false;
  }
  if (text) text.textContent = '';

  $('#payRequisite').textContent = qr || '—';
  $('#payQrAmount').textContent = `${data.amount} ₽`;

  const target = data.paymentUrl || qr;
  const link = $('#payOpen');
  if (target && /^https:\/\//i.test(target)) {
    link.href = target;
    link.hidden = false;
  } else {
    link.hidden = true;
  }

  const fallback = $('#payFallback');
  if (target) {
    fallback.href = target;
    fallback.hidden = false;
  } else {
    fallback.hidden = true;
  }

  payShow('QrBlock');
}

/**
 * Простой QR по строке реквизитов: модули строим из хэша символов. Рядом
 * всегда есть сама ссылка и кнопка «Копировать» — её и оплачивают.
 */
function qrPayload(text) {
  const canvas = document.createElement('canvas');
  const size = 232;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';

  const bits = [];
  for (const ch of String(text)) {
    let h = 2166136261;
    for (let i = 0; i < ch.length; i++) {
      h ^= ch.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    for (let b = 0; b < 32; b++) bits.push((h >> b) & 1);
  }

  const cells = 25;
  const step = Math.floor(size / cells);
  const off = Math.floor((size - step * cells) / 2);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if (bits[(y * cells + x) % bits.length]) ctx.fillRect(off + x * step, off + y * step, step, step);
    }
  }
  return canvas.toDataURL('image/png');
}

/** Опрашиваем заказ: оплату подтверждает сервер, а не браузер. */
async function payPoll(order) {
  try {
    const data = await api(`/api/billing/requisites?invoice=${encodeURIComponent(order.invoiceId)}`);
    if (data.status === 'paid') {
      payStop();
      payStage('Готово', 'Платёж получен, подписка включена');
      await loadBilling();
      renderSubscription();
      loadStats();
      payShow('Success');
      return true;
    }
    if (data.status === 'ready') {
      payStage('Оплатите заказ', 'После оплаты доступ выдастся автоматически');
      payShowQr(data);
    }
    return false;
  } catch {
    return false;
  }
}

async function buySubscription() {
  payStop();
  payStage('Подготовка платежа', 'Создаём заказ…');
  payShow('Loading');
  history.pushState({}, '', '#/pay');
  route();

  try {
    const order = await api('/api/billing/checkout', { method: 'POST' });
    $('#payPlan').textContent = `Подписка на ${order.periodDays} дней`;
    $('#payAmount').textContent = `${order.amountRub} ₽`;
    $('#payOrderId').textContent = order.invoiceId || '—';
    $('#payCopy').onclick = async () => {
      const ok = await copyText($('#payRequisite').textContent);
      toast(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'ok' : 'err');
    };
    $('#payRetry').onclick = buySubscription;

    // Провайдер с редиректом уводит к себе, остальные платим прямо здесь.
    if (order.paymentUrl) {
      sessionStorage.setItem('fo:pay', '1');
      window.location.href = order.paymentUrl;
      return;
    }

    if (order.requisites?.status === 'ready') payShowQr(order.requisites);
    await payPoll(order);
    if (!payTimer) payTimer = setInterval(() => payPoll(order), 5000);
  } catch (err) {
    payFail(err.message);
  }
}

/** Человек вернулся с оплаты: подписка могла ещё не появиться — подождём. */
async function watchPayment() {
  if (sessionStorage.getItem('fo:pay') !== '1') return;
  sessionStorage.removeItem('fo:pay');

  for (let i = 0; i < 10; i++) {
    await loadBilling();
    if (state.billing?.subscription?.active) {
      renderSubscription();
      toast('Подписка активна — сроки снова твои', 'ok');
      loadStats();
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  toast('Оплата ещё обрабатывается — обнови страницу через минуту', 'info');
}

/** Контакты внизу главной: приходят с сервера вместе со статистикой. */
/** Контакты в панели управления: список с удалением. */
async function loadContacts() {
  const box = $('#contactList');
  if (!box) return;

  const data = await api('/api/admin/contacts');
  box.replaceChildren();

  if (!data.contacts.length) {
    const empty = document.createElement('li');
    empty.className = 'muted empty-note';
    empty.textContent = 'Контактов пока нет — добавь первый, он появится внизу главной.';
    box.append(empty);
    return;
  }

  for (const item of data.contacts) {
    const li = document.createElement('li');
    li.className = 'note-item';

    const body = document.createElement('div');
    body.className = 'note-body';
    const title = document.createElement('b');
    title.textContent = item.title;
    // Пометка, что контакт копируется по клику: иначе в панели не видно, что он особенный.
    if (item.copyOnClick) {
      title.append(icon('i-copy', 'note-flag'));
      title.lastElementChild.title = 'Копируется по нажатию';
    }
    const value = document.createElement('small');
    value.textContent = item.value;
    body.append(title, value);

    const del = button('Удалить', 'i-trash-sm', 'btn btn-sm btn-danger');
    del.addEventListener('click', async () => {
      try {
        await api(`/api/admin/contacts/${item.id}`, { method: 'DELETE' });
        toast('Контакт удалён', 'ok');
        await loadContacts();
        loadStats();
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    li.append(body, del);
    box.append(li);
  }
}

/** Контакты внизу главной: приходят с сервера вместе со статистикой. */
/** Готовый цвет для панелек: приводим к #rrggbb, мусор не пропускаем. */
function normalizeLineColor(value) {
  const hex = String(value || '').trim().replace(/^#/, '');
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : '#ffc043';
}

/**
 * Раздаёт выбранный цвет в CSS-переменные. Оттенки считаем сами, а не через
 * color-mix: Яндекс.Браузер и старые сборки его не знают, и панельки стали бы
 * без обводки. На светлой теме цвет притемняем — иначе иконки и подписи гаснут.
 */
function applyLineColor(value) {
  const color = normalizeLineColor(value);
  const n = parseInt(color.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const light = document.documentElement.dataset.theme === 'light';
  const ink = light ? rgb.map((c) => Math.round(c * 0.55)) : rgb;
  const style = document.documentElement.style;

  style.setProperty('--line', color);
  style.setProperty('--line-ink', `rgb(${ink.join(', ')})`);
  // Светлый фон съедает тонкую обводку — прибавляем плотности.
  // rgba() собираем строго через запятые: «rgba(255 192 67, 0.45)» браузер не понимает.
  const density = light ? 1.5 : 1;
  for (const [name, alpha] of [['--line-08', 0.08], ['--line-16', 0.16], ['--line-45', 0.45], ['--line-80', 0.8]]) {
    style.setProperty(name, `rgba(${rgb.join(', ')}, ${Math.min(0.92, alpha * density)})`);
  }
}

/** Поле выбора цвета в панели: ставит значение и сразу примеряет на странице. */
function setLineColorField(value) {
  const input = $('#setLineColor');
  if (!input) return;
  input.value = normalizeLineColor(value);
  applyLineColor(input.value);
  for (const swatch of document.querySelectorAll('.line-swatch')) {
    swatch.classList.toggle('is-active', swatch.dataset.line === input.value.toLowerCase());
  }
}

function renderContacts(contacts) {
  const box = $('#homeContacts');
  if (!box) return;

  const list = Array.isArray(contacts) ? contacts : [];
  box.replaceChildren();
  box.hidden = list.length === 0;

  for (const item of list) {
    // Панелька как на макете: иконка в квадрате, название, значение под ним.
    // Ссылка всегда кликабельна; с флажком «копировать» — ещё и копирует значение.
    const copies = !!item.copyOnClick;
    const node = document.createElement(item.kind === 'link' ? 'a' : copies ? 'button' : 'span');
    node.className = item.kind === 'link' ? 'home-contact' : 'home-contact is-text';
    if (node.tagName === 'BUTTON') node.type = 'button';
    if (item.kind === 'link') {
      node.href = item.value;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    } else if (copies) {
      node.tabIndex = 0;
    }

    if (copies) {
      const copy = async () => {
        const ok = await copyText(item.value);
        toast(ok ? `Скопировано: ${item.value}` : 'Не удалось скопировать — скопируйте вручную', ok ? 'ok' : 'err');
      };
      node.addEventListener('click', (e) => {
        // У ссылки своё открытие в новой вкладке, отменять его не надо.
        if (item.kind !== 'link') e.preventDefault();
        copy();
      });
      if (item.kind !== 'link') {
        node.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            copy();
          }
        });
      }
    }

    const badge = document.createElement('span');
    badge.className = 'home-contact-icon';
    badge.append(icon(item.kind === 'link' ? 'i-link' : 'i-share'));
    node.append(badge);

    const name = document.createElement('span');
    name.className = 'home-contact-name';
    name.textContent = item.title;
    node.append(name);

    const hint = document.createElement('small');
    hint.textContent = item.value;
    node.append(hint);

    if (copies) {
      // Значок в углу: панелька сама подсказывает, что по ней можно кликнуть.
      const badge = document.createElement('span');
      badge.className = 'home-contact-copy';
      badge.setAttribute('aria-hidden', 'true');
      badge.append(icon('i-copy'));
      node.append(badge);
    }

    box.append(node);
  }
}

function renderStoragePill(storage) {
  const pill = $('#storagePill');
  const text = $('#storageText');
  // Подпись всегда одна, а состояние показывает точка и подсказка при наведении.
  text.textContent = 'Статус системы';
  if (storage.degraded) {
    pill.dataset.state = 'warn';
    pill.title = storage.lastError
      ? `Хранилище работает в аварийном режиме. ${storage.lastError}`
      : 'Файлы хранятся в памяти воркера и исчезнут после перезапуска';
  } else {
    pill.dataset.state = 'ok';
    pill.title = 'Файлы, аккаунты и настройки сохраняются в надёжном облачном хранилище';
  }
}

function renderStorageNotice(storage) {
  const notice = $('#storageNotice');
  if (!storage.degraded) {
    notice.hidden = true;
    return;
  }
  notice.hidden = false;
  notice.replaceChildren();
  const reason = storage.lastError ? `Причина: ${storage.lastError}. ` : 'Токен хранилища не задан. ';
  notice.append(
    document.createTextNode(
      `${reason}Сейчас файлы живут в памяти воркера и исчезнут после перезапуска — это демо-режим. Чтобы включить постоянное хранилище, впиши рабочий токен: `,
    ),
  );
  const code = document.createElement('code');
  code.textContent = 'npx wrangler secret put UPSTASH_BLOB_TOKEN';
  notice.append(code, document.createTextNode(' (и обнови значение UPSTASH_BLOB_URL в wrangler.jsonc).'));
}

/**
 * Срок жизни и режим «одноразовая» выбирают после загрузки, поэтому в форме
 * загрузки остаётся одна подсказка. Гостям срок назначает администратор, и он
 * меняется в панели управления — подсказка подхватывает новое значение.
 */
function renderUploadHint(stats = state.stats) {
  const text = $('#uploadHintText');
  if (!text) return;

  const hours = Number(stats?.settings?.anonymousTtlHours ?? 1) || 1;
  state.ttl = hours;

  if (!state.user) {
    text.textContent =
      `Срок жизни ссылки и режим «одноразовая» выбираются после загрузки файла. ` +
      `Гостям ограничено до ${hours} ${plural(hours, ['часа', 'часов', 'часов'])}.`;
    return;
  }

  // У зарегистрированного срок зависит от подписки: без неё — сутки,
  // с подпиской — выбирает сам, до потолка из настроек.
  const billing = state.billing;
  if (!billing) {
    text.textContent = 'Срок жизни ссылки и режим «одноразовая» выбираются после загрузки файла.';
    return;
  }

  const sub = billing.subscription || {};
  const option = billing.ttl?.options?.[0]?.label || '24 часа';
  if (sub.active) {
    text.textContent =
      `Срок жизни ссылки и режим «одноразовая» выбираются после загрузки файла. ` +
      `С подпиской доступно до ${sub.maxTtlDays || 30} дней.`;
    return;
  }
  text.textContent =
    `Срок жизни ссылки и режим «одноразовая» выбираются после загрузки файла. ` +
    `Подписка открывает выбор до ${sub.maxTtlDays || 30} дней, без неё ссылка живёт ${option}.`;
}

/* ---------------------------- Окно создания ссылок --------------------------- */

/**
 * После загрузки файл не висит панелькой в карточке: его срок выбирают в
 * отдельном окне, там же появляется готовая ссылка. Ошибки — только в
 * уведомлении справа.
 */
/**
 * Пока открыто модальное окно, фон не скроллится и не анимируется: под
 * размытым окном любая анимация заставляет браузер пересчитывать размытие
 * во весь экран на каждом кадре — отсюда были подтормаживания.
 */
function lockScroll(on) {
  const gap = window.innerWidth - document.documentElement.clientWidth;
  document.body.classList.toggle('is-modal-open', on);
  document.body.style.overflow = on ? 'hidden' : '';
  // Компенсируем исчезающий скроллбар, иначе страница дёрнется вбок.
  document.body.style.paddingRight = on && gap > 0 ? `${gap}px` : '';
}

const linkModal = {
  rows: new Map(), // id файла → элемент строки
  order: [], // id файлов в порядке появления

  open() {
    const modal = $('#linkModal');
    if (modal) modal.hidden = false;
    lockScroll(true);
  },

  close() {
    const modal = $('#linkModal');
    if (modal) modal.hidden = true;
    lockScroll(false);
    this.order = [];
    this.rows.clear();
    const list = $('#linkList');
    if (list) list.replaceChildren();
    const done = $('#linkDoneWrap');
    if (done) done.hidden = true;
  },

  /** Файл загружен, но срок ещё не выбран. */
  add(data) {
    const list = $('#linkList');
    if (!list) return;

    if (!this.rows.size) this.open();

    const row = document.createElement('div');
    row.className = 'link-row';

    const head = document.createElement('div');
    head.className = 'link-row-head';
    const name = document.createElement('b');
    name.textContent = data.file.name;
    const size = document.createElement('span');
    size.className = 'muted';
    size.textContent = bytes(data.file.size);
    head.append(name, size);
    row.append(head);

    const body = document.createElement('div');
    body.className = 'link-row-body';
    row.append(body);

    this.rows.set(data.file.id, { row, body, data });
    this.order.push(data.file.id);
    list.append(row);

    this.render(data.file.id);
  },

  /** Рисует текущий шаг: выбор срока либо готовую ссылку. */
  render(id) {
    const entry = this.rows.get(id);
    if (!entry) return;

    const { row, body, data } = entry;
    body.replaceChildren();

    if (data.link) {
      const link = document.createElement('div');
      link.className = 'q-link';
      const text = document.createElement('b');
      // Именно hash-ссылка: путь /f/<id> открывался бы совсем без стилей,
      // потому что относительные ссылки на CSS уезжают в /f/.
      const url = shareUrl(data.file.id);
      text.textContent = url;
      link.append(icon('i-link'), text);

      const copy = button('Копировать', 'i-copy');
      copy.addEventListener('click', async () => {
        const ok = await copyText(url);
        toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать', ok ? 'ok' : 'err');
      });

      const open = button('Открыть', 'i-share');
      open.addEventListener('click', () => window.open(url, '_blank', 'noopener'));

      body.append(link, copy, open);
      return;
    }

    const guest = !state.user;
    let hours = Number(state.billing?.ttl?.options?.[0]?.hours ?? 24);
    let once = false;

    const wrap = document.createElement('div');
    wrap.className = 'q-ttl';

    const options = state.billing?.ttl?.options?.length
      ? state.billing.ttl.options
      : state.stats?.ttlOptions || [{ hours: 24, label: '24 часа' }];

    const label = document.createElement('span');
    label.className = 'q-ttl-label';
    label.textContent = 'срок жизни';
    wrap.append(label);

    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'q-ttl-btn';
      btn.textContent = opt.label;
      btn.setAttribute('aria-pressed', String(hours === opt.hours));
      btn.addEventListener('click', () => {
        hours = opt.hours;
        for (const other of wrap.querySelectorAll('.q-ttl-btn')) {
          other.setAttribute('aria-pressed', String(other === btn));
        }
      });
      wrap.append(btn);
    }

    wrap.append(onceToggle((value) => {
      once = value;
    }));

    const create = button('Создать ссылку', 'i-link');
    create.addEventListener('click', async () => {
      create.disabled = true;
      try {
        const done = await api(`/api/file/${data.file.id}/link`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-owner-token': state.owners[data.file.id] || '',
          },
          body: JSON.stringify(guest ? { once } : { hours, once }),
        });
        this.rows.get(id).data.link = done.links;
        this.render(id);
        const doneWrap = $('#linkDoneWrap');
        if (doneWrap) doneWrap.hidden = false;
        toast(`«${done.file.name}» готов к обмену`, 'ok');
      } catch (err) {
        create.disabled = false;
        toast(err.message || 'Не удалось создать ссылку', 'err');
      }
    });

    wrap.append(create);
    body.append(wrap);
  },

  /** Если ссылка создана хотя бы для одного файла — показываем «Готово». */
  maybeShowDone() {
    const anyLink = [...this.rows.values()].some((entry) => entry.data.link);
    const doneWrap = $('#linkDoneWrap');
    if (doneWrap) doneWrap.hidden = !anyLink;
  },
}

function initLinkModal() {
  $('#linkClose')?.addEventListener('click', () => linkModal.close());
  $('#linkDone')?.addEventListener('click', () => linkModal.close());
  $('#linkModal .modal-backdrop')?.addEventListener('click', () => linkModal.close());
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#linkModal').hidden) linkModal.close();
  });
}

/* ----------------------------- Загрузка ---------------------------- */


/**
 * Загрузка файла в два шага: Worker подписывает прямую ссылку в Upstash,
 * браузер кладёт байты сам (с прогрессом в уведомлении) и подтверждает
 * загрузку. Файл не идёт через Worker — нет лимита на размер запроса.
 *
 * Отдельных панелей в карточке нет: прогресс идёт в уведомление справа,
 * а выбор срока и готовая ссылка — в окне создания ссылок.
 */
async function uploadFile(file) {
  const limit = (state.stats?.maxFileSizeMb ?? 500) * 1024 * 1024;
  if (file.size > limit) {
    toast(`«${file.name}» больше ${bytes(limit)}`, 'err');
    return;
  }

  const ownerToken = randomToken();
  const showProgress = (text) => {
    toast(`«${file.name}»: ${text}`, 'info', 2400);
  };

  try {
    const sign = await api('/api/upload/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        ttl: String(state.ttl),
        once: state.once,
        ownerToken,
        // Вошедшие выбирают срок после загрузки — ссылка появится позже.
        pendingTtl: !!state.user,
      }),
    });

    // Аварийный режим (нет секрета хранилища) — файл идёт через Worker.
    if (sign.memory) {
      await uploadThroughWorker(file, ownerToken, showProgress);
      return;
    }

    await putWithProgress(sign.payload, file, (pct) => showProgress(`${pct}%`));

    showProgress('сохраняю…');
    // Метаданные отправляем ровно те байты, которые подписал Worker,
    // иначе R2 отклонит подпись. Поэтому Worker отдаёт само тело.
    await putWithProgress(sign.meta, new TextEncoder().encode(sign.metaBody ?? ''));

    const done = await api('/api/upload/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: sign.file.id }),
    });

    state.owners[done.file.id] = ownerToken;
    saveJSON('fo:owners', state.owners);
    linkModal.add(done);
    loadStats();
  } catch (err) {
    toast(err.message || `«${file.name}»: загрузка не удалась`, 'err');
  }
}

/** PUT по подписанной ссылке с прогрессом. */
function putWithProgress(target, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', target.url);

    for (const [name_, value] of Object.entries(target.headers || {})) {
      // content-length выставляет сам браузер, его задавать нельзя
      if (name_.toLowerCase() === 'content-length') continue;
      xhr.setRequestHeader(name_, value);
    }

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (!e.lengthComputable) return;
        onProgress(Math.round((e.loaded / e.total) * 100));
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Хранилище ответило ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('Сеть недоступна при отправке в хранилище')));
    xhr.addEventListener('abort', () => reject(new Error('Загрузка отменена')));

    xhr.send(blob);
  });
}

/** Запасной путь для аварийного режима: multipart через Worker. */
function uploadThroughWorker(file, ownerToken, showProgress) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('ttl', String(state.ttl));
    form.append('once', state.once ? '1' : '0');
    form.append('ownerToken', ownerToken);
    form.append('pendingTtl', state.user ? '1' : '0');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/upload'));

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      showProgress(`${Math.round((e.loaded / e.total) * 100)}%`);
    });

    xhr.addEventListener('load', () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* не JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.file) {
        state.owners[data.file.id] = ownerToken;
        saveJSON('fo:owners', state.owners);
        linkModal.add(data);
        loadStats();
      } else {
        toast(data?.error?.message || `Ошибка ${xhr.status}`, 'err');
      }
      resolve();
    });

    xhr.addEventListener('error', () => {
      toast('Сеть недоступна при отправке в хранилище', 'err');
      resolve();
    });

    xhr.send(form);
  });
}





/** Очередь с ограничением параллелизма, чтобы не забить канал. */
async function enqueue(files) {
  if (state.maintenance) {
    toast('Технические работы: загрузка временно закрыта', 'err');
    return;
  }

  const max = state.stats?.maxFiles ?? 4;
  const list = [...files].slice(0, max);
  if (files.length > max) {
    toast(`Берём первые ${max} ${plural(max, ['файл', 'файла', 'файлов'])}`, 'info');
  }

  for (const file of list) {
    while (state.activeUploads >= 2) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    state.activeUploads += 1;
    uploadFile(file);
    state.activeUploads -= 1;
  }
}

function initDropzone() {
  const zone = $('#dropzone');
  const input = $('#fileInput');
  const depth = { current: 0 };

  zone.addEventListener('click', () => {
    if (state.maintenance) return;
    input.click();
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!state.maintenance) input.click();
    }
  });

  input.addEventListener('change', () => {
    if (input.files?.length) enqueue(input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((type) =>
    zone.addEventListener(type, (e) => {
      e.preventDefault();
      if (type === 'dragenter') depth.current += 1;
      zone.classList.add('is-dragging');
    }),
  );

  zone.addEventListener('dragleave', () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) zone.classList.remove('is-dragging');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    depth.current = 0;
    zone.classList.remove('is-dragging');
    if (e.dataTransfer?.files?.length) enqueue(e.dataTransfer.files);
  });

  // Не даём браузеру открыть файл, если его случайно уронили мимо зоны.
  ['dragover', 'drop'].forEach((type) =>
    window.addEventListener(type, (e) => {
      if (!zone.contains(e.target)) e.preventDefault();
    }),
  );
}

/* ----------------------------- Роутер ------------------------------ */

// Защита от гонки: пока летел ответ для одной ссылки, пользователь мог уйти
// на другую — устаревший ответ игнорируем.
let renderToken = 0;

function showHome() {
  renderToken += 1;
  $('#view-file').hidden = true;
  $('#view-profile').hidden = true;
  $('#view-home').hidden = false;
  document.title = 'Файлообменник — обменивайся файлами без карт и регистрации';
  loadStats();
}

async function showFile(id) {
  const token = (renderToken += 1);
  $('#view-home').hidden = true;
  $('#view-profile').hidden = true;
  $('#view-file').hidden = false;
  $('#fileError').hidden = true;
  $('#fileCard').hidden = false;
  $('#preview').hidden = true;
  $('#preview').replaceChildren();
  $('#deleteBtn').hidden = true;
  $('#fileMeta').replaceChildren();

  try {
    const { file } = await api(`/api/file/${id}`);
    if (token !== renderToken) return;
    renderFile(file);
  } catch (err) {
    if (token !== renderToken) return;
    $('#fileCard').hidden = true;
    $('#fileError').hidden = false;
    $('#errorText').textContent = err.message;
    document.title = 'Файл недоступен — Файлообменник';
    if (err.status === 410) $('#errorTitle').textContent = 'Ссылка больше недоступна';
    else if (err.status === 404) $('#errorTitle').textContent = 'Файл не найден';
  }
}

function renderFile(file) {
  $('#fileMeta').replaceChildren();
  document.title = `${file.name} — Файлообменник`;
  $('#fileName').textContent = file.name;
  $('#fileSub').textContent = `${bytes(file.size)} · ${file.type || 'двоичный файл'}`;

  const downloadUrl = apiUrl(`/api/file/${file.id}?dl=1`);
  const pageUrl = shareUrl(file.id);
  $('#downloadBtn').href = downloadUrl;

  const cells = [
    ['Размер', bytes(file.size)],
    ['Загружен', dateTime(file.createdAt)],
    ['Удаление через', timeLeft(file.expiresAt)],
    ['Скачиваний', String(file.downloads)],
  ];
  if (file.once) cells.push(['Режим', 'одноразовая ссылка']);

  const meta = $('#fileMeta');
  for (const [label, value] of cells) {
    const cell = document.createElement('div');
    cell.className = 'meta-cell';
    const l = document.createElement('span');
    l.className = 'meta-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'meta-value';
    v.textContent = value;
    cell.append(l, v);
    meta.append(cell);
  }

  // Обратный отсчёт, если срок ограничен
  if (file.expiresAt) {
    const cell = meta.children[2];
    const value = cell.querySelector('.meta-value');
    const tick = () => {
      value.textContent = timeLeft(file.expiresAt);
    };
    const timer = setInterval(tick, 30000);
    addEventListener('pagehide', () => clearInterval(timer), { once: true });
  }

  $('#copyLinkBtn').onclick = async () => {
    const ok = await copyText(pageUrl);
    toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать', ok ? 'ok' : 'err');
  };

  $('#downloadBtn').onclick = () => {
    if (file.once) toast('Ссылка одноразовая: после скачивания файл будет удалён', 'info');
  };

  const ownerToken = state.owners[file.id];
  if (ownerToken) {
    const del = $('#deleteBtn');
    del.hidden = false;
    del.onclick = async () => {
      if (!confirm(`Удалить «${file.name}» без возможности восстановления?`)) return;
      try {
        await api(`/api/file/${file.id}`, { method: 'DELETE', headers: { 'x-owner-token': ownerToken } });
        delete state.owners[file.id];
        saveJSON('fo:owners', state.owners);
        toast('Файл удалён', 'ok');
        setTimeout(() => {
          history.pushState({}, '', '#/');
          showHome();
        }, 700);
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }

  renderPreview(file);
}

function renderPreview(file) {
  const host = $('#preview');
  const url = apiUrl(`/api/raw/${file.id}`);
  const type = (file.type || '').toLowerCase();
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const textExt = ['txt', 'md', 'csv', 'log', 'json', 'yml', 'yaml', 'xml', 'html', 'css', 'js', 'ts', 'py'];
  let node = null;

  if (type.startsWith('image/')) {
    node = document.createElement('img');
    node.src = url;
    node.alt = file.name;
    node.loading = 'lazy';
  } else if (type.startsWith('video/')) {
    node = document.createElement('video');
    node.src = url;
    node.controls = true;
    node.playsInline = true;
  } else if (type.startsWith('audio/')) {
    node = document.createElement('audio');
    node.src = url;
    node.controls = true;
  } else if (type.startsWith('text/') || type.includes('json') || textExt.includes(ext)) {
    const pre = document.createElement('pre');
    pre.textContent = 'Загружаем превью…';
    node = pre;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('empty'))))
      .then((text) => {
        pre.textContent = text.slice(0, 20000) || '(пустой файл)';
      })
      .catch(() => {
        pre.textContent = 'Превью недоступно';
      });
  }

  if (node) {
    host.replaceChildren(node);
    host.hidden = false;
  }
}

/** Текущий id из hash (#/f/<id>); путь /f/<id> тоже понимаем — для запуска без Pages. */
function currentFileId() {
  const fromHash = /^#\/f\/([a-z0-9]{4,32})$/.exec(location.hash)?.[1];
  if (fromHash) return fromHash;
  return /^\/f\/([a-z0-9]{4,32})$/.exec(location.pathname)?.[1] || null;
}

function route() {
  // Разметка и скрипт могли разъехаться по версии (старый кэш вкладки):
  // тогда какого-то блока просто нет, и это не повод ронять всю страницу.
  const show = (id) => {
    const view = $(id);
    if (view) view.hidden = true;
  };
  show('#view-home');
  show('#view-file');
  show('#view-profile');
  show('#view-pay');

  // Страница сменилась, а окно осталось закрыто — снимаем блокировку прокрутки,
  // иначе сайт нельзя было бы прокрутить.
  if ($('#authModal').hidden && $('#linkModal').hidden) lockScroll(false);

  if (location.hash.startsWith('#/pay')) {
    // Страница оплаты: без входа её не открыть — платить нечем.
    if (!state.user) {
      openAuthModal('login');
      history.pushState({}, '', '#/profile');
      route();
      return;
    }
    payStop();
    const view = $('#view-pay');
    if (!view) return;
    view.hidden = false;
    loadBilling().then(renderSubscription);
    return;
  }

  if (location.hash.startsWith('#/profile')) {
    const view = $('#view-profile');
    if (!view) return;
    view.hidden = false;
    renderProfile();
    return;
  }

  const id = currentFileId();
  if (id) showFile(id);
  else showHome();
}

/* ------------------------------ Старт ------------------------------ */

function init() {
  // Пока не пришли ни настройки, ни сессия, показываем «глухую» страницу:
  // иначе при перезагрузке мелькают кнопки входа и зона загрузки.
  document.documentElement.classList.add('booting');
  // Страховка: даже если что-то сломается, кнопки и форма должны появиться.
  setTimeout(() => document.documentElement.classList.remove('booting'), 5000);

  // Каждый кусок включаем отдельно: один сбойный не должен гасить остальной.
  const step = (name, fn) => {
    try {
      fn();
    } catch (err) {
      console.error(`${name} не запустился:`, err);
    }
  };

  step('тема', initTheme);
  step('загрузка файлов', initDropzone);
  step('окно ссылок', initLinkModal);
  step('вход', initAuth);
  step('панель управления', initAdmin);
  step('шапка', renderAuth);
  step('страница', route);

  addEventListener('popstate', route);
  addEventListener('hashchange', route);

  // Мягкая навигация без перезагрузки для внутренних ссылок вида /f/<id>
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="/"]');
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || link.target === '_blank') return;
    e.preventDefault();
    const href = link.getAttribute('href');
    // На Pages путь /f/<id> недоступен — переводим в hash.
    const target = /^\/f\/([a-z0-9]{4,32})$/.test(href) ? `#${href}` : '#/';
    history.pushState({}, '', target);
    route();
    scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Снимаем «глухой» экран, когда оба запроса вернулись — что бы ни случилось.
  Promise.allSettled([loadProfile(), loadStats()]).finally(() => {
    document.documentElement.classList.remove('booting');
  });

  // Вернулся с оплаты: ждём, пока подписка появится.
  step('возврат с оплаты', watchPayment);

  setInterval(() => {
    if (!$('#view-home').hidden) loadStats();
  }, 60000);
}

init();