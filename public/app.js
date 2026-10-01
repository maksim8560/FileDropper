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

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  // Сессия живёт в localStorage и передаётся заголовком: так работает и когда
  // фронт на GitHub Pages, а API на другом домене (куки там были бы third-party).
  if (state.token) headers.authorization = `Bearer ${state.token}`;

  const res = await fetch(apiUrl(path), { cache: 'no-store', ...options, headers });
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

function toast(message, kind = 'info') {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  el.append(icon(kind === 'ok' ? 'i-check' : kind === 'err' ? 'i-x' : 'i-bolt'), document.createTextNode(message));
  host.append(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 4200);
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
  // Переключатель срока появляется только после входа
  if (state.stats) renderTtlGroup(state.stats);
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
  setTimeout(() => $('#loginInput').focus(), 60);
}

function closeAuthModal() {
  $('#authModal').hidden = true;
  $('#authForm').reset();
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
  $('#ttlHint').addEventListener('click', () => openAuthModal('login'));

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
  if (file.expiresAt) bits.push(`удалится ${timeLeft(file.expiresAt)}`);
  if (file.once) bits.push('одноразовая');
  if (file.expired) bits.push('срок истёк');
  if (badge) bits.push(badge);
  sub.textContent = bits.join(' · ');
  body.append(name, sub);

  const actions = document.createElement('div');
  actions.className = 'q-actions';

  const copy = button('Копировать', 'i-copy');
  copy.addEventListener('click', async () => {
    const ok = await copyText(shareUrl(file.id));
    toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать', ok ? 'ok' : 'err');
  });
  actions.append(copy);

  if (onDelete) {
    const del = button('Удалить', 'i-trash-sm', 'btn btn-sm btn-danger');
    del.addEventListener('click', async () => {
      if (!confirm(`Удалить «${file.name}»?`)) return;
      try {
        await onDelete(file);
        toast('Файл удалён', 'ok');
      } catch (err) {
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
  const data = await loadProfile();
  if (!data) {
    openAuthModal('login');
    history.pushState({}, '', '#/');
    route();
    return;
  }

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
      }),
    });
    toast('Настройки сохранены', 'ok');
    loadStats();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function initAdmin() {
  $('#adminForm').addEventListener('submit', saveSettings);

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
  });
}

/* --------------------------- Статистика ---------------------------- */

async function loadStats() {
  try {
    const stats = await api('/api/stats');
    state.stats = stats;

    $('#statFiles').textContent = stats.listed ? String(stats.files) : '—';
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
      const maint = $('#maintenanceNotice');
      maint.hidden = !stats.settings.maintenance;
    }

    renderStoragePill(stats.storage);
    renderTtlGroup(stats);
    renderStorageNotice(stats.storage);
  } catch {
    $('#statFiles').textContent = '—';
    renderStoragePill({ degraded: true, provider: 'offline' });
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

function renderTtlGroup(stats = state.stats) {
  const all = stats?.ttlOptions || [
    { hours: 1, label: '1 час' },
    { hours: 24, label: '24 часа' },
    { hours: 168, label: '7 дней' },
    { hours: 0, label: 'Навсегда' },
  ];

  // Срок выбирают только авторизованные: гостям показываем подсказку вместо
  // переключателя — выбирать всё равно нечего.
  const logged = !!state.user;
  const group = $('#ttlGroup');
  const hint = $('#ttlHint');

  if (!logged) {
    group.replaceChildren();
    group.hidden = true;
    hint.hidden = false;
    const hours = Number(stats?.settings?.anonymousTtlHours ?? 1) || 1;
    state.ttl = hours;
    $('#ttlHintText').textContent =
      `Ссылка живёт ${hours} ${plural(hours, ['час', 'часа', 'часов'])} — потом файл удалится безвозвратно. ` +
      'Войди, чтобы выбрать другой срок.';
    return;
  }

  group.hidden = false;
  hint.hidden = true;
  const options = all;
  state.ttl = Number(stats?.defaultTtlHours ?? 24) || 24;

  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.role = 'radio';
    btn.textContent = opt.label;
    btn.dataset.hours = String(opt.hours);
    btn.setAttribute('aria-checked', String(opt.hours === state.ttl));
    btn.addEventListener('click', () => {
      state.ttl = opt.hours;
      $$('#ttlGroup button').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
    });
    group.append(btn);
  }
}

/* ----------------------------- Загрузка ---------------------------- */

function queueItem() {
  const li = document.createElement('li');
  li.className = 'q-item';

  const ic = document.createElement('div');
  ic.className = 'q-icon';
  ic.append(icon('i-file'));

  const body = document.createElement('div');
  body.className = 'q-body';
  const name = document.createElement('div');
  name.className = 'q-name';
  const sub = document.createElement('div');
  sub.className = 'q-sub';
  const bar = document.createElement('div');
  bar.className = 'q-progress';
  const fill = document.createElement('i');
  bar.append(fill);
  body.append(name, sub, bar);

  const actions = document.createElement('div');
  actions.className = 'q-actions';

  li.append(ic, body, actions);
  return { li, name, sub, bar, fill, actions };
}

/**
 * Загрузка файла в два шага: Worker подписывает прямую ссылку в Upstash,
 * браузер кладёт байты сам (с прогрессом) и подтверждает загрузку.
 * Так файл не идёт через Worker — нет лимита на размер запроса.
 */
async function uploadFile(file) {
  const { li, name, sub, fill, actions } = queueItem();
  name.textContent = file.name;
  sub.textContent = `${bytes(file.size)} · готовлю ссылку…`;
  $('#queue').append(li);

  const limit = (state.stats?.maxFileSizeMb ?? 500) * 1024 * 1024;
  if (file.size > limit) {
    failItem(sub, fill, `Файл больше ${bytes(limit)}`);
    return;
  }

  const ownerToken = randomToken();

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
      }),
    });

    // Аварийный режим (нет секрета хранилища) — файл идёт через Worker.
    if (sign.memory) {
      await uploadThroughWorker(file, ownerToken, { sub, fill, actions });
      return;
    }

    await putWithProgress(sign.payload, file, (pct) => {
      fill.style.width = `${pct}%`;
      sub.textContent = `${bytes(file.size)} · ${pct}%`;
    });

    sub.textContent = `${bytes(file.size)} · сохраняю…`;
    // Метаданные отправляем ровно теми байтами, которые подписал Worker,
    // иначе R2 отклонит подпись. Поэтому Worker отдаёт само тело.
    await putWithProgress(sign.meta, new TextEncoder().encode(sign.metaBody ?? ''));

    const done = await api('/api/upload/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: sign.file.id }),
    });

    state.owners[done.file.id] = ownerToken;
    saveJSON('fo:owners', state.owners);
    doneItem(sub, fill, done, actions);
    loadStats();
  } catch (err) {
    failItem(sub, fill, err.message || 'Загрузка не удалась');
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
function uploadThroughWorker(file, ownerToken, ui) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('ttl', String(state.ttl));
    form.append('once', state.once ? '1' : '0');
    form.append('ownerToken', ownerToken);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/upload'));

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      ui.fill.style.width = `${pct}%`;
      ui.sub.textContent = `${bytes(file.size)} · ${pct}%`;
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
        doneItem(ui.sub, ui.fill, data, ui.actions);
        loadStats();
        resolve();
      } else {
        failItem(ui.sub, ui.fill, data?.error?.message || `Ошибка ${xhr.status}`);
        resolve();
      }
    });

    xhr.addEventListener('error', () => {
      failItem(ui.sub, ui.fill, 'Сеть недоступна');
      resolve();
    });

    xhr.send(form);
  });
}

function doneItem(sub, fill, data, actions) {
  fill.style.width = '100%';
  sub.replaceChildren();
  sub.append(document.createTextNode(`${bytes(data.file.size)} · готово`));

  const link = document.createElement('div');
  link.className = 'q-link';
  const linkText = document.createElement('b');
  linkText.textContent = data.links.page;
  link.append(icon('i-link'), linkText);

  const copy = button('Копировать', 'i-copy');
  copy.addEventListener('click', async () => {
    const ok = await copyText(shareUrl(data.file.id));
    toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать', ok ? 'ok' : 'err');
  });

  const open = button('Открыть', 'i-share');
  open.addEventListener('click', () => window.open(data.links.page, '_blank', 'noopener'));

  actions.replaceChildren(link, copy, open);
  toast(`«${data.file.name}» готов к обмену`, 'ok');
}

function failItem(sub, fill, message) {
  fill.parentElement.remove();
  sub.replaceChildren();
  const err = document.createElement('span');
  err.className = 'q-error';
  err.textContent = message;
  sub.append(err);
  toast(message, 'err');
}

/** Очередь с ограничением параллелизма, чтобы не забить канал. */
async function enqueue(files) {
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

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
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

  $('#onceToggle').addEventListener('change', (e) => {
    state.once = e.target.checked;
  });
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
  $('#view-home').hidden = true;
  $('#view-file').hidden = true;
  $('#view-profile').hidden = true;

  if (location.hash.startsWith('#/profile')) {
    $('#view-profile').hidden = false;
    renderProfile();
  } else {
    const id = currentFileId();
    if (id) showFile(id);
    else showHome();
  }
}

/* ------------------------------ Старт ------------------------------ */

function init() {
  initTheme();
  initDropzone();
  initAuth();
  initAdmin();
  renderAuth();
  loadProfile();
  route();

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

  loadStats();
  setInterval(() => {
    if (!$('#view-home').hidden) loadStats();
  }, 60000);
}

init();