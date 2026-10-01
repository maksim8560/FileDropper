/**
 * Файлообменник — клиентская логика.
 * Роутер /  и  /f/:id , загрузка с прогрессом, копирование ссылок, тема.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Адрес API. Фронт живёт на GitHub Pages, API — на отдельном Worker'е,
 * поэтому все запросы строятся отсюда (в dev apiBase пустой — тот же домен).
 */
const API_BASE = String(window.FILEX?.apiBase || '').replace(/\/+$/, '');
const apiUrl = (path) => `${API_BASE}${path}`;

const state = {
  stats: null,
  ttl: 24,
  once: false,
  owners: loadJSON('fo:owners', {}),
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
  const res = await fetch(apiUrl(path), { cache: 'no-store', ...options });
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
    $('#statBackend').textContent = stats.storage.degraded ? 'в памяти' : 'Upstash Blob';
    $('#limitsHint').textContent = `До ${stats.maxFileSizeMb} МБ на файл · до ${stats.maxFiles ?? 4} ${
      'файлов'
    } за раз`;

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
  if (storage.degraded) {
    pill.dataset.state = 'warn';
    text.textContent = storage.lastError ? 'токен не принят' : 'аварийный режим';
    pill.title = storage.lastError || 'Файлы хранятся в памяти воркера';
  } else {
    pill.dataset.state = 'ok';
    text.textContent = 'Upstash Blob';
    pill.title = 'Файлы сохраняются в Upstash Blob';
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

function renderTtlGroup(stats) {
  const group = $('#ttlGroup');
  group.replaceChildren();
  const options = stats.ttlOptions || [
    { hours: 1, label: '1 час' },
    { hours: 24, label: '24 часа' },
    { hours: 168, label: '7 дней' },
    { hours: 0, label: 'Навсегда' },
  ];
  state.ttl = stats.defaultTtlHours ?? 24;

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

function uploadFile(file) {
  const { li, name, sub, fill, actions } = queueItem();
  name.textContent = file.name;
  sub.textContent = `${bytes(file.size)} · загрузка…`;
  $('#queue').append(li);

  const limit = (state.stats?.maxFileSizeMb ?? 25) * 1024 * 1024;
  if (file.size > limit) {
    failItem(sub, fill, `Файл больше ${bytes(limit)}`);
    return;
  }

  const ownerToken = randomToken();
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
    fill.style.width = `${pct}%`;
    sub.textContent = `${bytes(file.size)} · ${pct}%`;
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
      doneItem(sub, fill, data, actions);
      loadStats();
    } else {
      failItem(sub, fill, data?.error?.message || `Ошибка ${xhr.status}`);
    }
  });

  xhr.addEventListener('error', () => failItem(sub, fill, 'Сеть недоступна'));
  xhr.addEventListener('abort', () => failItem(sub, fill, 'Загрузка отменена'));
  xhr.send(form);
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
  $('#view-home').hidden = false;
  document.title = 'Файлообменник — обменивайся файлами без карт и регистрации';
  loadStats();
}

async function showFile(id) {
  const token = (renderToken += 1);
  $('#view-home').hidden = true;
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
  const id = currentFileId();
  if (id) showFile(id);
  else showHome();
}

/* ------------------------------ Старт ------------------------------ */

function init() {
  initTheme();
  initDropzone();
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