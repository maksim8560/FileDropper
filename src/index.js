/**
 * Файлообменник — Cloudflare Worker: API, авторизация, отдача статики.
 *
 *   GET    /api/health                 — диагностика хранилища
 *   GET    /api/stats                  — лимиты, сроки, состояние хранилища
 *   POST   /api/auth/register          — регистрация (логин + пароль)
 *   POST   /api/auth/login             — вход, возвращает токен сессии
 *   GET    /api/auth/me                — профиль текущего пользователя
 *   POST   /api/auth/logout            — выход, удаляет сессию
 *   GET    /api/me/files               — файлы пользователя
 *   POST   /api/upload                 — загрузка одного файла (multipart)
 *   GET    /api/file/:id               — метаданные файла (JSON)
 *   GET    /api/file/:id?dl=1          — скачивание (поток, поддержка Range)
 *   GET    /api/raw/:id                — сырой поток для превью
 *   DELETE /api/file/:id               — удаление (токен владельца или сессия)
 *
 * Данные лежат в Upstash Blob:
 *   f/<id>/<имя>      — сам файл
 *   m/<id>.json       — метаданные файла
 *   u/<hash>.json     — пользователь (логин, соль, хеш пароля)
 *   s/<hash>.json     — сессия
 *   ui/<userId>.json  — индекс файлов пользователя
 */

import { createStorage, StorageError } from './storage.js';
import { createKv } from './kv.js';

/* ----------------------------- утилиты ----------------------------- */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'cross-origin-opener-policy': 'same-origin',
};

/**
 * CORS: фронт на GitHub Pages, API здесь, поэтому домены разные.
 * Открываем все источники: авторизация по кукам не используется, токен сессии
 * передаётся явно заголовком Authorization, поэтому wildcard безопасен.
 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, x-owner-token, authorization',
  'access-control-expose-headers': 'content-length, content-range, content-disposition, x-file-name, accept-ranges',
  'access-control-max-age': '86400',
};

function buildCsp(extraConnect = '') {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self'${extraConnect}`,
  ].join('; ');
}

/** Заголовки HTML-документа: в connect-src добавляем адрес API. */
function documentHeaders(env) {
  const apiOrigin = String(env.PUBLIC_API_ORIGIN || '').trim().replace(/\/+$/, '');
  return { ...SECURITY_HEADERS, 'content-security-policy': buildCsp(apiOrigin ? ` ${apiOrigin}` : '') };
}

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const META_PREFIX = 'm/';
const FILE_PREFIX = 'f/';
const NOTE_PREFIX = 'notes/';
const USER_PREFIX = 'user/';
const SESSION_PREFIX = 'session/';
const INDEX_PREFIX = 'userfiles/';
const SETTINGS_KEY = 'settings/global';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const PBKDF2_ITERATIONS = 100_000;

/** Варианты срока жизни ссылки: их же показывает форма, их же проверяет сервер. */
const TTL_OPTIONS = [
  { hours: 1, label: '1 час' },
  { hours: 24, label: '24 часа' },
  { hours: 168, label: '7 дней' },
  { hours: 0, label: 'Навсегда' },
];
const TTL_HOURS_ALLOWED = TTL_OPTIONS.map((o) => o.hours);

/**
 * Запасной срок для файла, у которого срок ещё не выбрали. Если пользователь
 * закрыл вкладку и не вернулся, cron удалит такой файл, а не будет хранить вечно.
 */
const PENDING_TTL_HOURS = 6;

/** Настройки сайта: значения по умолчанию перекрываются тем, что сохранил админ. */
const DEFAULT_SETTINGS = {
  heroTitle: 'Обменивайся\nфайлами за секунду',
  heroLede: 'Перетащи файл — получишь ссылку. Кто угодно откроет её и скачает файл.',
  maxFileSizeMb: 500,
  maxFilesPerUpload: 4,
  defaultTtlHours: 24,
  allowRegistration: true,
  maintenance: false,
  anonymousTtlHours: 1,
};

/**
 * Потолок размера. Cloudflare режет тело запроса: 100 МБ на Free/Pro,
 * 200 МБ на Business. Значение выше — это уже предел платформы, а не настройки.
 */
const PLATFORM_MAX_MB = 500;

const limits = (env) => ({
  maxFileSize: Math.max(1, Number(env.MAX_FILE_SIZE_MB) || PLATFORM_MAX_MB) * 1024 * 1024,
  maxFiles: Math.max(1, Number(env.MAX_FILES_PER_UPLOAD) || 4),
  defaultTtlHours: Number(env.DEFAULT_TTL_HOURS ?? 24),
});

/**
 * Лимиты с учётом настроек из панели управления: админ может поменять
 * максимальный размер и срок по умолчанию без деплоя.
 */
async function effectiveLimits(env, kv) {
  const base = limits(env);
  const settings = await readSettings(kv);
  return {
    settings,
    maxFileSize: clamp(Number(settings.maxFileSizeMb), 1, PLATFORM_MAX_MB) * 1024 * 1024,
    maxFiles: clamp(Number(settings.maxFilesPerUpload), 1, 10),
    defaultTtlHours: clamp(Number(settings.defaultTtlHours), 0, 24 * 365),
  };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function fail(status, message, code = 'error', extra = {}) {
  return json({ error: { code, message, ...extra } }, status);
}

function newId(len = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

const CYRILLIC_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** ASCII-ключ в хранилище: транслитерация, чтобы заголовки не ломались. */
function asciiSlug(name) {
  const slug = String(name)
    .toLowerCase()
    .split('')
    .map((ch) => CYRILLIC_MAP[ch] ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return slug || 'file';
}

function displayName(name) {
  const cleaned = String(name).replace(/[\u0000-\u001f\u007f\\/]/g, '').trim().slice(0, 120);
  return cleaned || 'file';
}

function contentDisposition(name, inline = false) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (str) => new Uint8Array((str.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));

async function sha(value) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** PBKDF2-SHA256, 100k итераций — пароль в открытом виде нигде не хранится. */
async function hashPassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unhex(saltHex), iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return hex(bits);
}

function randomToken(bytes = 24) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Грубый лимитер запросов на IP: окно в мс и максимум попыток. */
function rateLimiter(windowMs, max) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}

const allowUpload = rateLimiter(10 * 60 * 1000, 60);
const allowAuth = rateLimiter(10 * 60 * 1000, 20);

/**
 * Фоновая задача после ответа. Именно ctx.waitUntil: без него изолят
 * замораживается сразу после ответа и фоновая запись теряется.
 */
function background(ctx, promise) {
  ctx.waitUntil(Promise.resolve(promise).catch((err) => console.warn('background task failed:', err?.message || err)));
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'local';
}

/* --------------------------- авторизация --------------------------- */

function normalizeLogin(login) {
  return String(login || '').trim().toLowerCase();
}

function validateCredentials(login, password) {
  const name = String(login || '').trim();
  const pass = String(password || '');
  if (name.length < 3 || name.length > 40) return 'Логин: от 3 до 40 символов';
  // Разрешаем буквы (включая кириллицу), цифры, @, точку, дефис, подчёркивание
  if (!/^[\p{L}\p{N}@._\- ]+$/u.test(name)) {
    return 'Логин: буквы, цифры, @, точка, дефис или подчёркивание';
  }
  if (pass.length < 8) return 'Пароль: минимум 8 символов';
  if (pass.length > 200) return 'Пароль: максимум 200 символов';
  return null;
}

async function readJson(storage, key) {
  const data = await storage.get(key);
  if (!data) return null;
  try {
    return JSON.parse(await new Response(data.body).text());
  } catch {
    return null;
  }
}

/* ------------------------- настройки сайта -------------------------- */

async function readSettings(kv) {
  const saved = await kv.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

async function writeSettings(kv, patch, username) {
  const current = await readSettings(kv);
  const next = { ...current, ...patch, updatedAt: Date.now(), updatedBy: username };
  await kv.put(SETTINGS_KEY, next);
  return next;
}

/** Админ — это логин из ADMIN_LOGINS (список через запятую в wrangler.jsonc). */
function isAdmin(username, env) {
  const list = String(env.ADMIN_LOGINS || '')
    .split(',')
    .map((s) => normalizeLogin(s))
    .filter(Boolean);
  return list.includes(normalizeLogin(username));
}

/** Возвращает сессию админа или готовый ответ 401/403. */
async function requireAdmin(request, env, kv) {
  const session = await readSession(kv, request);
  if (!session) return { error: fail(401, 'Нужно войти в аккаунт', 'unauthorized') };
  if (!isAdmin(session.username, env)) return { error: fail(403, 'Раздел доступен только администратору', 'forbidden') };
  return { session };
}

/** Ключи пользователей и сессий — хеш, чтобы логин и токен не светились в базе. */
async function userKey(login) {
  return `${USER_PREFIX}${await sha(normalizeLogin(login))}`;
}

async function sessionKey(token) {
  return `${SESSION_PREFIX}${await sha(token)}`;
}

async function findUser(kv, login) {
  return kv.get(await userKey(login));
}

async function saveUser(kv, user) {
  await kv.put(await userKey(user.username), user);
}

async function createSession(kv, user) {
  const token = randomToken(24);
  const session = {
    userId: user.id,
    username: user.username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL,
  };
  // TTL ставит сам Redis — просроченные сессии исчезают без крона.
  await kv.put(await sessionKey(token), session, { ttlSeconds: Math.floor(SESSION_TTL / 1000) });
  return { token, session };
}

async function readSession(kv, request) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const session = await kv.get(await sessionKey(token));
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < Date.now()) return null;
  return { ...session, token };
}

async function handleRegister(request, env, kv) {
  if (!allowAuth(clientIp(request))) return fail(429, 'Слишком много попыток. Подождите несколько минут.', 'rate_limited');

  const { settings } = await effectiveLimits(env, kv);
  if (!settings.allowRegistration) {
    return fail(403, 'Регистрация сейчас закрыта', 'registration_closed');
  }

  const body = await request.json().catch(() => null);
  if (!body) return fail(400, 'Нужен JSON с логином и паролем', 'bad_json');

  const { login, password } = body;
  const problem = validateCredentials(login, password);
  if (problem) return fail(400, problem, 'invalid_credentials');

  if (await findUser(kv, login)) {
    return fail(409, 'Такой логин уже занят', 'login_taken');
  }

  const salt = randomToken(16);
  const user = {
    id: newId(12),
    username: String(login).trim(),
    salt,
    hash: await hashPassword(password, salt),
    iterations: PBKDF2_ITERATIONS,
    createdAt: Date.now(),
  };
  await kv.put(await userKey(user.username), user);

  const { token } = await createSession(kv, user);
  return json({ ok: true, token, user: { id: user.id, username: user.username, createdAt: user.createdAt } }, 201);
}

async function handleLogin(request, env, kv) {
  if (!allowAuth(clientIp(request))) return fail(429, 'Слишком много попыток. Подождите несколько минут.', 'rate_limited');

  const body = await request.json().catch(() => null);
  if (!body) return fail(400, 'Нужен JSON с логином и паролем', 'bad_json');

  const user = await findUser(kv, body.login);
  const password = String(body.password || '');

  // Считаем хеш даже когда пользователя нет — чтобы не отличать по времени ответа
  const salt = user?.salt || '00'.repeat(16);
  const candidate = await hashPassword(password, salt, user?.iterations || PBKDF2_ITERATIONS);

  if (!user || candidate !== user.hash) {
    return fail(401, 'Неверный логин или пароль', 'bad_credentials');
  }

  const { token } = await createSession(kv, user);
  return json({ ok: true, token, user: { id: user.id, username: user.username, createdAt: user.createdAt } });
}

async function handleLogout(request, kv) {
  const session = await readSession(kv, request);
  if (session) await kv.del(await sessionKey(session.token));
  return json({ ok: true });
}

async function handleMe(request, env, kv, ctx) {
  const session = await readSession(kv, request);
  if (!session) return fail(401, 'Нужно войти в аккаунт', 'unauthorized');

  const index = (await kv.get(`${INDEX_PREFIX}${session.userId}`)) || [];
  const files = index.filter((f) => !f.expiresAt || f.expiresAt > Date.now());
  const user = await findUser(kv, session.username);

  return json({
    ok: true,
    user: {
      id: session.userId,
      username: session.username,
      createdAt: user?.createdAt ?? null,
      isAdmin: isAdmin(session.username, env),
    },
    files: files.slice().reverse(),
    totals: {
      files: files.length,
      bytes: files.reduce((sum, f) => sum + (f.size || 0), 0),
    },
    session: { expiresAt: session.expiresAt },
  });
}

/* ------------------------- заметки и данные ------------------------- */

/**
 * Произвольные записи владельца: заметки, тексты, любые мелкие данные сайта.
 * Лежат рядом с файлами в том же бакете, ключи notes/<id>.json.
 */
async function handleNotes(request, env, kv, id = null) {
  const gate = await requireAdmin(request, env, kv);
  if (gate.error) return gate.error;

  const listNotes = async () => {
    const { keys } = await kv.list(NOTE_PREFIX, 200);
    const notes = [];
    for (const key of keys) {
      const note = await kv.get(key);
      if (note) notes.push(note);
    }
    return notes.sort((a, b) => b.updatedAt - a.updatedAt);
  };

  if (id) {
    const key = `${NOTE_PREFIX}${id}`;
    const note = await kv.get(key);

    if (request.method === 'DELETE') {
      if (!note) return fail(404, 'Запись не найдена', 'not_found');
      await kv.del(key);
      return json({ ok: true, deleted: id });
    }

    if (request.method === 'PUT') {
      const body = await request.json().catch(() => null);
      if (!body) return fail(400, 'Нужен JSON с данными', 'bad_json');
      const next = {
        ...(note || { id, createdAt: Date.now() }),
        title: String(body.title ?? note?.title ?? 'Без названия').slice(0, 120),
        text: String(body.text ?? note?.text ?? '').slice(0, 20000),
        updatedAt: Date.now(),
      };
      await kv.put(key, next);
      return json({ ok: true, note: next });
    }

    return fail(405, 'Метод не поддерживается', 'method_not_allowed');
  }

  if (request.method === 'GET') return json({ ok: true, notes: await listNotes() });

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body) return fail(400, 'Нужен JSON с данными', 'bad_json');
    const note = {
      id: newId(8),
      title: String(body.title || 'Без названия').slice(0, 120),
      text: String(body.text || '').slice(0, 20000),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await kv.put(`${NOTE_PREFIX}${note.id}`, note);
    return json({ ok: true, note }, 201);
  }

  return fail(405, 'Метод не поддерживается', 'method_not_allowed');
}

/* ------------------------- панель управления ------------------------ */

async function handleAdminSettings(request, env, kv) {
  const gate = await requireAdmin(request, env, kv);
  if (gate.error) return gate.error;

  if (request.method === 'GET') {
    return json({ ok: true, settings: await readSettings(kv) });
  }

  if (request.method !== 'PUT') return fail(405, 'Метод не поддерживается', 'method_not_allowed');

  const body = await request.json().catch(() => null);
  if (!body) return fail(400, 'Нужен JSON с настройками', 'bad_json');

  const patch = {};
  if (typeof body.heroTitle === 'string') patch.heroTitle = body.heroTitle.slice(0, 200);
  if (typeof body.heroLede === 'string') patch.heroLede = body.heroLede.slice(0, 400);
  if (body.maxFileSizeMb !== undefined) patch.maxFileSizeMb = clamp(Number(body.maxFileSizeMb), 1, PLATFORM_MAX_MB);
  if (body.maxFilesPerUpload !== undefined) patch.maxFilesPerUpload = clamp(Number(body.maxFilesPerUpload), 1, 10);
  if (body.defaultTtlHours !== undefined) patch.defaultTtlHours = clamp(Number(body.defaultTtlHours), 0, 24 * 365);
  if (body.anonymousTtlHours !== undefined) patch.anonymousTtlHours = clamp(Number(body.anonymousTtlHours), 1, 24 * 30);
  if (body.allowRegistration !== undefined) patch.allowRegistration = !!body.allowRegistration;
  if (body.maintenance !== undefined) patch.maintenance = !!body.maintenance;

  const settings = await writeSettings(kv, patch, gate.session.username);
  return json({ ok: true, settings });
}

async function handleAdminOverview(request, env, kv, storage) {
  const gate = await requireAdmin(request, env, kv);
  if (gate.error) return gate.error;

  const { blobs: fileMeta } = await storage.list(META_PREFIX, 200);
  const users = await kv.count(USER_PREFIX);
  const sessions = await kv.count(SESSION_PREFIX);
  const notes = await kv.count(NOTE_PREFIX);

  const recent = [];
  let bytes = 0;
  for (const item of fileMeta.slice(0, 40)) {
    const key = item.pathname || item.path;
    if (!key) continue;
    const id = key.slice(META_PREFIX.length).replace(/\.json$/, '');
    const meta = await readMeta(storage, id);
    if (!meta) continue;
    bytes += meta.size || 0;
    recent.push({
      id: meta.id,
      name: meta.name,
      size: meta.size,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt ?? null,
      downloads: meta.downloads || 0,
      once: !!meta.once,
      userId: meta.userId || null,
      expired: isExpired(meta),
      spent: !!meta.spentAt,
    });
  }

  return json({
    ok: true,
    storage: storage.status(),
    ping: storage.ping ? await storage.ping() : { ok: false },
    counts: {
      files: fileMeta.length,
      users,
      sessions,
      notes,
      bytes,
    },
    recent: recent.sort((a, b) => b.createdAt - a.createdAt),
  });
}

async function handleAdminCleanup(request, env, kv, storage, ctx) {
  const gate = await requireAdmin(request, env, kv);
  if (gate.error) return gate.error;
  if (request.method !== 'POST') return fail(405, 'Метод не поддерживается', 'method_not_allowed');

  const removed = await cleanup(storage, kv);
  return json({ ok: true, removed });
}

/** Удалить любой файл из панели управления. */
async function handleAdminDelete(request, env, kv, storage, id, ctx) {
  const gate = await requireAdmin(request, env, kv);
  if (gate.error) return gate.error;

  const meta = await readMeta(storage, id);
  if (!meta) return fail(404, 'Файл не найден', 'not_found');

  await removeFile(storage, meta);
  if (meta.userId) background(ctx, removeFromUserIndex(kv, meta.userId, id));
  return json({ ok: true, deleted: id });
}

/* --------------------------- маршрутизация -------------------------- */

async function handleApi(request, env, url, storage, kv, ctx) {
  const { pathname } = url;
  const cfg = await effectiveLimits(env, kv);

  /* --- диагностика --- */
  if (pathname === '/api/health') {
    const ping = storage.ping ? await storage.ping() : { ok: false };
    const kv = createKv(env);
    return json({ ok: ping.ok === true, storage: storage.status(), accounts: kv.status(), ping, kvPing: await kv.ping() });
  }

  /* --- статистика для главной --- */
  if (pathname === '/api/stats') {
    let files = 0;
    let listed = false;
    try {
      const { blobs } = await storage.list(META_PREFIX, 500);
      files = blobs.length;
      listed = true;
    } catch {
      listed = false;
    }
    return json({
      files,
      listed,
      maxFileSizeMb: Math.round(cfg.maxFileSize / 1024 / 1024),
      maxFiles: cfg.maxFiles,
      storage: storage.status(),
      settings: {
        heroTitle: cfg.settings.heroTitle,
        heroLede: cfg.settings.heroLede,
        maintenance: cfg.settings.maintenance,
        allowRegistration: cfg.settings.allowRegistration,
        anonymousTtlHours: clamp(Number(cfg.settings.anonymousTtlHours ?? 1), 1, 24 * 30) || 1,
      },
      ttlOptions: TTL_OPTIONS,
      defaultTtlHours: cfg.defaultTtlHours,
      auth: { enabled: true },
    });
  }

  /* --- авторизация --- */
  if (pathname === '/api/auth/register') {
    if (request.method !== 'POST') return fail(405, 'Метод не поддерживается', 'method_not_allowed');
    return handleRegister(request, env, kv);
  }

  if (pathname === '/api/auth/login') {
    if (request.method !== 'POST') return fail(405, 'Метод не поддерживается', 'method_not_allowed');
    return handleLogin(request, env, kv);
  }

  if (pathname === '/api/auth/logout') {
    if (request.method !== 'POST') return fail(405, 'Метод не поддерживается', 'method_not_allowed');
    return handleLogout(request, kv);
  }

  if (pathname === '/api/auth/me') {
    return handleMe(request, env, kv, ctx);
  }

  /* --- панель управления --- */
  if (pathname === '/api/admin/settings') {
    return handleAdminSettings(request, env, kv);
  }

  if (pathname === '/api/admin/overview') {
    return handleAdminOverview(request, env, kv, storage);
  }

  if (pathname === '/api/admin/cleanup') {
    return handleAdminCleanup(request, env, kv, storage, ctx);
  }

  const adminDelete = /^\/api\/admin\/files\/([a-z0-9]{4,32})$/.exec(pathname);
  if (adminDelete) {
    if (request.method !== 'DELETE') return fail(405, 'Метод не поддерживается', 'method_not_allowed');
    return handleAdminDelete(request, env, kv, storage, adminDelete[1], ctx);
  }

  /* --- заметки и данные сайта --- */
  if (pathname === '/api/admin/notes') {
    return handleNotes(request, env, kv);
  }

  const noteItem = /^\/api\/admin\/notes\/([a-z0-9]{4,32})$/.exec(pathname);
  if (noteItem) {
    return handleNotes(request, env, kv, noteItem[1]);
  }

  /* --- мои файлы --- */
  if (pathname === '/api/me/files') {
    const session = await readSession(kv, request);
    if (!session) return fail(401, 'Нужно войти в аккаунт', 'unauthorized');
    const index = (await kv.get(`${INDEX_PREFIX}${session.userId}`)) || [];
    return json({ ok: true, files: index.filter((f) => !f.expiresAt || f.expiresAt > Date.now()).reverse() });
  }

  /* --- загрузка: подпись → прямая отправка → фиксация --- */

  // Аварийный режим (нет секрета) — файл идёт через Worker, как раньше.
  if (pathname === '/api/upload') {
    if (request.method !== 'POST') return fail(405, 'Метод не поддерживается', 'method_not_allowed');

    const gate = await uploadGate(request, cfg);
    if (gate.error) return gate.error;

    let form;
    try {
      form = await request.formData();
    } catch {
      return fail(400, 'Не удалось разобрать запрос', 'bad_form');
    }

    const file = form.get('file');
    if (!file || typeof file === 'string') return fail(400, 'Файл не передан', 'no_file');
    if (file.size === 0) return fail(400, 'Файл пустой', 'empty_file');

    const meta = await buildMeta({
      cfg,
      session: await readSession(kv, request),
      name: file.name,
      type: file.type,
      size: file.size,
      ttl: form.get('ttl'),
      once: form.get('once') === '1' || form.get('once') === 'true',
      ownerToken: form.get('ownerToken')?.toString(),
      pendingTtl: form.get('pendingTtl') === '1' || form.get('pendingTtl') === 'true',
    });

    if (meta.size > cfg.maxFileSize) return tooLarge(cfg);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await storage.put(meta.key, bytes, { contentType: meta.type, size: bytes.byteLength });
      await saveMeta(storage, meta);
      if (meta.userId) background(ctx, addToUserIndex(kv, meta.userId, meta));
    } catch (err) {
      return storageFailure(err);
    }

    return json({ ok: true, file: publicMeta(meta), links: linksFor(meta), userId: meta.userId }, 201);
  }

  /* Подпись: браузер положит файл сам, без прохода через Worker. */
  if (pathname === '/api/upload/sign') {
    if (request.method !== 'POST') return fail(405, 'Метод не поддерживается', 'method_not_allowed');

    const gate = await uploadGate(request, cfg);
    if (gate.error) return gate.error;

    const body = await request.json().catch(() => null);
    if (!body) return fail(400, 'Нужен JSON с именем и размером файла', 'bad_json');

    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0) return fail(400, 'Размер файла неизвестен', 'bad_size');
    if (size > cfg.maxFileSize) return tooLarge(cfg);

    const meta = await buildMeta({
      cfg,
      session: await readSession(kv, request),
      name: body.name,
      type: body.type,
      size,
      ttl: body.ttl,
      once: body.once,
      ownerToken: body.ownerToken,
      // Вошедшие выбирают срок после загрузки, поэтому файл пока без ссылки.
      pendingTtl: body.pendingTtl === true,
    });

    if (storage.provider === 'memory') {
      // Аварийный режим: подписывать нечем, клиент пойдёт через /api/upload.
      return json({ ok: true, memory: true, file: publicMeta(meta), links: linksFor(meta) });
    }

    try {
      const metaJson = JSON.stringify(meta);
      const [payload, metaPart] = await Promise.all([
        storage.signedUpload(meta.key, meta.type, meta.size),
        storage.signedUpload(`${META_PREFIX}${meta.id}.json`, 'application/json; charset=utf-8', byteLength(metaJson)),
      ]);

      // Подпись может не выдатьcя даже у настоящего хранилища — тогда
      // отдаём клиенту аварийный путь, а не ошибку.
      if (!payload?.url || !metaPart?.url) {
        return json({ ok: true, memory: true, file: publicMeta(meta), links: linksFor(meta) });
      }

      return json(
        {
          ok: true,
          file: publicMeta(meta),
          links: linksFor(meta),
          userId: meta.userId,
          payload: { url: payload.url, headers: payload.headers },
          meta: { url: metaPart.url, headers: metaPart.headers },
          // Отдаём и само тело метаданных: клиент обязан отправить ровно те
          // байты, что подписаны, иначе R2 отклонит подпись.
          metaBody: metaJson,
          expiresIn: 900,
        },
        201,
      );
    } catch (err) {
      return storageFailure(err);
    }
  }

  /* Фиксация: проверяем, что файл и метаданные долели, и правим индекс. */
  if (pathname === '/api/upload/complete') {
    if (request.method !== 'POST') return fail(405, 'Метод не поддерживается', 'method_not_allowed');

    const body = await request.json().catch(() => null);
    const id = body?.id;
    if (!id || !/^[a-z0-9]{4,32}$/.test(String(id))) return fail(400, 'Нужен корректный id', 'bad_id');

    const meta = await readMeta(storage, id);
    if (!meta) return fail(409, 'Файл не долетел до хранилища — попробуйте ещё раз', 'upload_incomplete');

    const payload = await storage.get(meta.key);
    if (!payload) return fail(409, 'Файл не долетел до хранилища — попробуйте ещё раз', 'upload_incomplete');

    if (meta.userId) background(ctx, addToUserIndex(kv, meta.userId, meta));
    return json({ ok: true, file: publicMeta(meta), links: linksFor(meta) });
  }

  /**
   * Ссылку создают после загрузки: срок жизни (и одноразовость) выбирают в
   * этом запросе, и только вместе с ответом появляется сама ссылка.
   */
  const linkMatch = /^\/api\/file\/([a-z0-9]{4,32})\/link$/.exec(pathname);
  if (linkMatch) {
    if (request.method !== 'POST') return fail(405, 'Метод не поддерживается', 'method_not_allowed');

    const id = linkMatch[1];
    const meta = await readMeta(storage, id);
    if (!meta) return fail(404, 'Файл не найден — ссылка неверная или файл уже удалён', 'not_found');
    if (isExpired(meta)) {
      background(ctx, removeFile(storage, meta));
      return fail(410, 'Срок хранения файла истёк', 'expired');
    }

    const session = await readSession(kv, request);
    const ownerToken = request.headers.get('x-owner-token') || '';
    const byToken = meta.owner && (await sha(ownerToken || 'x')).startsWith(meta.owner);
    const byAccount = !!session && !!meta.userId && session.userId === meta.userId;
    if (!byToken && !byAccount) return fail(403, 'Нет прав на этот файл', 'forbidden');

    const body = await request.json().catch(() => null);

    // Одноразовость можно поменять, пока по ссылке никто не скачал.
    if (body?.once !== undefined) {
      if (meta.downloads > 0 || meta.spentAt) {
        return fail(409, 'Ссылка уже использована — менять её нельзя', 'link_spent');
      }
      meta.once = !!body.once;
    }

    // Срок задают один раз и только владельцу аккаунта: гостям он назначен.
    if (meta.ttlPending) {
      if (!byAccount) {
        return fail(401, 'Войдите в аккаунт, чтобы выбрать срок жизни ссылки', 'unauthorized');
      }
      const hours = Number(body?.hours);
      if (!TTL_HOURS_ALLOWED.includes(hours)) {
        return fail(400, 'Срок должен быть один час, 24 часа, 7 дней или навсегда', 'bad_ttl');
      }
      meta.expiresAt = hours > 0 ? Date.now() + hours * 3600 * 1000 : null;
      meta.ttlPending = false;
      meta.ttlChosenAt = Date.now();
    }

    await saveMeta(storage, meta);
    if (meta.userId) background(ctx, updateUserIndex(kv, meta.userId, meta));

    return json({ ok: true, file: publicMeta(meta), links: linksFor(meta) });
  }

  /* --- конкретный файл --- */
  const fileMatch = /^\/api\/file\/([a-z0-9]{4,32})$/.exec(pathname);
  if (fileMatch) {
    const id = fileMatch[1];
    const meta = await readMeta(storage, id);
    if (!meta) return fail(404, 'Файл не найден — ссылка неверная или файл уже удалён', 'not_found');

    if (isExpired(meta)) {
      background(ctx, removeFile(storage, meta));
      return fail(410, 'Срок хранения файла истёк', 'expired');
    }

    // Одноразовая ссылка погашена: payload удалён, «надгробие» живёт сутки.
    if (meta.spentAt || (meta.once && meta.downloads > 0)) {
      return fail(410, 'Одноразовая ссылка уже использована — файл удалён после первого скачивания', 'link_spent');
    }

    const session = await readSession(kv, request);

    if (request.method === 'DELETE') {
      const ownerToken = request.headers.get('x-owner-token') || '';
      const byToken = meta.owner && (await sha(ownerToken)).startsWith(meta.owner);
      const byAccount = session && meta.userId && session.userId === meta.userId;
      if (!byToken && !byAccount) return fail(403, 'Нет прав на удаление этого файла', 'forbidden');
      await removeFile(storage, meta);
      if (byAccount) background(ctx, removeFromUserIndex(kv, session.userId, id));
      return json({ ok: true, deleted: id });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail(405, 'Метод не поддерживается', 'method_not_allowed');
    }

    if (url.searchParams.get('dl') !== '1') return json({ ok: true, file: publicMeta(meta) });

    const data = await storage.get(meta.key, { range: request.headers.get('range') });
    if (!data) return fail(404, 'Файл не найден в хранилище', 'not_found');

    meta.downloads += 1;
    meta.lastDownloadAt = Date.now();
    if (meta.once) {
      // Одноразовая ссылка: гасим её до выдачи байтов, иначе мгновенный
      // второй запрос успеет скачать файл повторно. Ограничиваем по времени,
      // чтобы просадка хранилища не превращалась в зависшую загрузку.
      meta.spentAt = Date.now();
      const spent = deletePayload(storage, meta).then(() => saveMeta(storage, meta));
      await Promise.race([spent, new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
    } else {
      background(ctx, saveMeta(storage, meta));
    }

    const headers = new Headers(SECURITY_HEADERS);
    headers.set('content-type', data.contentType || meta.type);
    if (data.contentLength) headers.set('content-length', data.contentLength);
    if (data.contentRange) headers.set('content-range', data.contentRange);
    if (data.etag) headers.set('etag', data.etag);
    headers.set('accept-ranges', data.acceptRanges || 'bytes');
    headers.set('content-disposition', contentDisposition(meta.name, url.searchParams.get('inline') === '1'));
    headers.set('cache-control', 'no-store');
    return new Response(data.body, { status: data.status || 200, headers });
  }

  /* --- сырой поток для превью --- */
  const rawMatch = /^\/api\/raw\/([a-z0-9]{4,32})$/.exec(pathname);
  if (rawMatch) {
    const meta = await readMeta(storage, rawMatch[1]);
    if (!meta) return fail(404, 'Файл не найден', 'not_found');
    if (isExpired(meta)) {
      background(ctx, removeFile(storage, meta));
      return fail(410, 'Срок хранения файла истёк', 'expired');
    }

    const data = await storage.get(meta.key, { range: request.headers.get('range') });
    if (!data) return fail(404, 'Файл не найден в хранилище', 'not_found');

    const headers = new Headers(SECURITY_HEADERS);
    headers.set('content-type', data.contentType || meta.type);
    if (data.contentLength) headers.set('content-length', data.contentLength);
    if (data.contentRange) headers.set('content-range', data.contentRange);
    headers.set('accept-ranges', data.acceptRanges || 'bytes');
    headers.set('content-disposition', contentDisposition(meta.name, true));
    headers.set('cache-control', 'private, max-age=0, must-revalidate');
    return new Response(data.body, { status: data.status || 200, headers });
  }

  return fail(404, 'Неизвестный метод API', 'api_not_found');
}

/* ----------------------------- помощники ----------------------------- */

function publicMeta(meta) {
  return {
    id: meta.id,
    name: meta.name,
    size: meta.size,
    type: meta.type,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt ?? null,
    once: !!meta.once,
    downloads: meta.downloads || 0,
    // Срок ещё не выбран: ссылка появляется только после выбора.
    ttlPending: !!meta.ttlPending,
  };
}

function isExpired(meta) {
  return !!meta.expiresAt && meta.expiresAt < Date.now();
}

async function readMeta(storage, id) {
  return readJson(storage, `${META_PREFIX}${id}.json`);
}

function saveMeta(storage, meta) {
  return storage.put(`${META_PREFIX}${meta.id}.json`, JSON.stringify(meta), {
    contentType: 'application/json; charset=utf-8',
  });
}

function deletePayload(storage, meta) {
  return storage.del(meta.key);
}

function removeFile(storage, meta) {
  return Promise.all([deletePayload(storage, meta), storage.del(`${META_PREFIX}${meta.id}.json`)]);
}

/** Индекс файлов пользователя: не больше 200 записей. */
async function addToUserIndex(kv, userId, meta) {
  const index = (await kv.get(`${INDEX_PREFIX}${userId}`)) || [];
  index.push({
    id: meta.id,
    name: meta.name,
    size: meta.size,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    downloads: meta.downloads || 0,
    ttlPending: !!meta.ttlPending,
  });
  await kv.put(`${INDEX_PREFIX}${userId}`, index.slice(-200));
}

async function removeFromUserIndex(kv, userId, fileId) {
  const index = (await kv.get(`${INDEX_PREFIX}${userId}`)) || [];
  await kv.put(`${INDEX_PREFIX}${userId}`, index.filter((f) => f.id !== fileId));
}

/** Обновляет запись индекса после смены срока жизни. */
async function updateUserIndex(kv, userId, meta) {
  const index = (await kv.get(`${INDEX_PREFIX}${userId}`)) || [];
  const pos = index.findIndex((f) => f.id === meta.id);
  const entry = {
    id: meta.id,
    name: meta.name,
    size: meta.size,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    downloads: meta.downloads || 0,
    ttlPending: !!meta.ttlPending,
  };
  if (pos === -1) index.push(entry);
  else index[pos] = entry;
  await kv.put(`${INDEX_PREFIX}${userId}`, index.slice(-200));
}

/** Чистка просроченных файлов, «надгробий» и сессий по cron-триггеру. */
async function cleanup(storage, kv) {
  let removed = 0;

  const { blobs } = await storage.list(META_PREFIX, 500);
  const tombstoneTtl = 24 * 3600 * 1000;
  for (const item of blobs) {
    const key = item.pathname || item.path;
    if (!key) continue;
    const id = key.slice(META_PREFIX.length).replace(/\.json$/, '');
    const meta = await readMeta(storage, id);
    if (!meta) {
      await storage.del(key).catch(() => {});
      removed += 1;
      continue;
    }
    if (isExpired(meta) || (meta.spentAt && Date.now() - meta.spentAt > tombstoneTtl)) {
      await removeFile(storage, meta).catch(() => {});
      if (meta.userId) await removeFromUserIndex(kv, meta.userId, id).catch(() => {});
      removed += 1;
    }
  }

  // Просроченные сессии Redis вычищает сам по TTL, вручную трогать нечего.

  return removed;
}

/* ---------------------------- загрузка ------------------------------ */

function byteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

function linksFor(meta) {
  return { page: `/f/${meta.id}`, download: `/api/file/${meta.id}?dl=1`, raw: `/api/raw/${meta.id}` };
}

function tooLarge(cfg) {
  return fail(413, `Файл больше лимита ${cfg.maxFileSize / 1024 / 1024} МБ`, 'too_large');
}

function storageFailure(err) {
  if (err instanceof StorageError) {
    return fail(err.status, err.message, err.code, { hint: err.hint, detail: err.detail });
  }
  return fail(502, 'Не удалось сохранить файл', 'storage_error');
}

/** Техрежим и лимит на IP — общие для всех вариантов загрузки. */
async function uploadGate(request, cfg) {
  if (cfg.settings.maintenance) {
    return { error: fail(503, 'Загрузки временно закрыты администратором', 'maintenance') };
  }
  if (!allowUpload(clientIp(request))) {
    return { error: fail(429, 'Слишком много загрузок. Подождите несколько минут.', 'rate_limited') };
  }
  return {};
}

/**
 * Собирает метаданные загрузки. Срок выбирают после загрузки: файл сначала
 * получает запасной дедлайн, а настоящий срок поставит /api/file/<id>/ttl.
 * Гостям срок не положен — им отдаётся короткий (по умолчанию 1 час).
 */
async function buildMeta({ cfg, session, name, type, size, ttl, once, ownerToken, pendingTtl = false }) {
  const anonTtl = clamp(Number(cfg.settings.anonymousTtlHours ?? 1), 1, 24 * 30) || 1;
  const requested = ttl === '' || ttl === null || ttl === undefined ? cfg.defaultTtlHours : Number(ttl);
  const valid = Number.isFinite(requested) && requested >= 0;
  const ttlHours = session ? (valid ? requested : cfg.defaultTtlHours) : anonTtl;

  const now = Date.now();
  const id = newId();
  const shown = displayName(name);
  const owner = (await sha(ownerToken || newId(24))).slice(0, 32);
  const defer = !!pendingTtl && !!session;

  return {
    id,
    name: shown,
    key: `${FILE_PREFIX}${id}/${asciiSlug(shown)}`,
    size: Number(size),
    type: String(type || 'application/octet-stream').slice(0, 120),
    createdAt: now,
    // Запасной срок нужен на случай, если пользователь ушёл и не выбрал срок:
    // cron удалит такой файл через PENDING_TTL_HOURS.
    expiresAt: defer
      ? now + PENDING_TTL_HOURS * 3600 * 1000
      : ttlHours > 0
        ? now + ttlHours * 3600 * 1000
        : null,
    ttlPending: defer,
    once: !!once,
    downloads: 0,
    lastDownloadAt: null,
    owner,
    userId: session?.userId ?? null,
  };
}


/* ------------------------------ Worker ------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Preflight для кросс-доменной загрузки с GitHub Pages
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        const res = await handleApi(request, env, url, createStorage(env), createKv(env), ctx);
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
        for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
        headers.set('content-security-policy', buildCsp());
        return new Response(res.body, { status: res.status, headers });
      }

      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      for (const [k, v] of Object.entries(documentHeaders(env))) headers.set(k, v);
      if (asset.headers.get('content-type')?.includes('text/html')) headers.set('cache-control', 'no-cache');
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    } catch (err) {
      console.error('worker error:', err);
      const status = err instanceof StorageError ? err.status : 500;
      return fail(status, err?.message || 'Внутренняя ошибка', 'internal_error');
    }
  },

  async scheduled(event, env, ctx) {
    const storage = createStorage(env);
    ctx.waitUntil(cleanup(storage, createKv(env)).catch((err) => console.warn('cleanup failed:', err?.message || err)));
  },
};