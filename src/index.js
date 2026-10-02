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

/**
 * Адреса, куда странице разрешено обращаться из браузера.
 *
 * Кроме адреса API сюда обязателен адрес хранилища: файл браузер кладёт
 * сам, по подписанной ссылке, и это запрос на другой домен. Без него
 * браузер тихо блокирует загрузку, а страница пишет «сеть недоступна».
 *
 * Подписанная ссылка упирается не в адрес бакета, а в R2-эндпоинт аккаунта
 * (*.r2.cloudflarestorage.com) — поэтому разрешаем оба. Подпись всё равно
 * проверяется на стороне хранилища, лишнего доступа это не даёт.
 */
function connectSources(env) {
  const list = new Set();
  for (const value of [env.PUBLIC_API_ORIGIN, env.UPSTASH_BLOB_URL]) {
    const origin = String(value || '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(origin)) list.add(origin);
  }
  list.add('https://*.r2.cloudflarestorage.com');
  return [...list].join(' ');
}

/** Заголовки HTML-документа: в connect-src добавляем API и хранилище. */
function documentHeaders(env) {
  const extra = connectSources(env);
  return { ...SECURITY_HEADERS, 'content-security-policy': buildCsp(extra ? ` ${extra}` : '') };
}

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const META_PREFIX = 'm/';
const FILE_PREFIX = 'f/';
const NOTE_PREFIX = 'notes/';
const USER_PREFIX = 'user/';
const SESSION_PREFIX = 'session/';
const INDEX_PREFIX = 'userfiles/';
const STATS_PREFIX = 'stats/';
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

/* --------------------- Платёжная система (провайдеры) --------------------- */

/**
 * Провайдеры приёма оплаты. У всех один и тот же контракт, поэтому смена
 * платёжной системы — это выбор в панели, а не правка кода.
 *
 *   manual        — оплаты нет, подписку выдаёт админ (по умолчанию);
 *   cloudpayments — редирект на страницу CloudPayments;
 *   h2h           — QR внутри нашей страницы: провайдер отдаёт реквизиты
 *                   (СБП, карта или крипта), а статус мы опрашиваем сами.
 */
const PAYMENT_PROVIDERS = {
  manual: { label: 'Без онлайн-оплаты, вручную', needsSecret: false },
  cloudpayments: { label: 'CloudPayments', needsSecret: true },
  h2h: { label: 'QR внутри сайта: СБП, карта, крипта', needsSecret: true },
};

function providerOf(cfg) {
  return PAYMENT_PROVIDERS[cfg.settings.subProvider] ? cfg.settings.subProvider : 'manual';
}

function providerReady(env, cfg) {
  if (providerOf(cfg) === 'cloudpayments') return cloudpaymentsConfigured(env);
  if (providerOf(cfg) === 'h2h') return h2hConfigured(env);
  return false;
}

/** Что показывать панели и кабинету о платёжной системе. */
function paymentInfo(env, cfg) {
  return {
    provider: providerOf(cfg),
    providers: Object.entries(PAYMENT_PROVIDERS).map(([id, p]) => ({ id, label: p.label })),
    ready: providerReady(env, cfg),
  };
}

/** Заказ на оплату: сумма, кому и на сколько. */
function orderPayload(cfg, session, invoiceId) {
  return {
    invoiceId,
    amountRub: clamp(Number(cfg.settings.subPriceRub), 0, 1000000),
    periodDays: clamp(Number(cfg.settings.subPeriodDays), 1, 365),
    maxTtlDays: clamp(Number(cfg.settings.subMaxTtlDays), 1, 365),
    description: 'Подписка Файлообменника',
    accountId: session.userId,
    username: session.username,
  };
}

/* ------------------------ CloudPayments ------------------------ */

/**
 * Запрос к API CloudPayments: логин — Public ID терминала, пароль — API Secret.
 * Секреты живут в секретах Worker'а, а не в коде. Идемпотентность — заголовок
 * X-Request-ID, иначе повторный запрос создаст второй заказ.
 */
async function cloudpayments(env, path, { method = 'GET', query = null, body = null, requestId = null } = {}) {
  const publicId = String(env.CLOUDPAYMENTS_PUBLIC_ID || '').trim();
  const secret = String(env.CLOUDPAYMENTS_SECRET_KEY || '').trim();
  if (!publicId || !secret) return { configured: false, ok: false, error: 'Платёжная система не подключена' };

  const url = new URL(`https://api.cloudpayments.ru${path}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);

  const headers = {
    authorization: `Basic ${btoa(`${publicId}:${secret}`)}`,
    'content-type': 'application/json',
  };
  if (requestId) headers['x-request-id'] = requestId;

  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    return { configured: true, ok: false, error: `Сеть недоступна: ${err?.message || err}` };
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || data?.Success === false) {
    return { configured: true, ok: false, error: data?.Message || `CloudPayments ответила ${res.status}` };
  }
  return { configured: true, ok: true, data: data?.Data ?? data };
}

function cloudpaymentsConfigured(env) {
  return !!(String(env.CLOUDPAYMENTS_PUBLIC_ID || '').trim() && String(env.CLOUDPAYMENTS_SECRET_KEY || '').trim());
}

/* ------------------------------ H2H ------------------------------ */

/**
 * Провайдер «реквизиты по запросу»: он отдаёт QR и ссылку, а оплату мы
 * подтверждаем опросом статуса — вебхук у таких сервисов часто отсутствует.
 * Все три адреса задаются в панели, поэтому подходит любой сервис с таким
 * контрактом, а код менять не нужно.
 */
const H2H_PATHS = {
  create: '/orders',
  requisites: '/orders/{id}/requisites',
  status: '/orders/{id}',
};

function h2hConfigured(env) {
  return !!(String(env.H2H_BASE_URL || '').trim() && String(env.H2H_API_KEY || '').trim());
}

async function h2h(env, path, { method = 'GET', body = null } = {}) {
  const base = String(env.H2H_BASE_URL || '').replace(/\/+$/, '');
  const key = String(env.H2H_API_KEY || '').trim();
  if (!base || !key) return { configured: false, ok: false, error: 'Платёжная система не подключена' };

  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { configured: true, ok: false, error: `Сеть недоступна: ${err?.message || err}` };
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return { configured: true, ok: false, error: data?.message || data?.error || `Провайдер ответил ${res.status}` };
  }
  return { configured: true, ok: true, data };
}

/** Нормализуем ответ провайдера в наш вид: статус, QR, ссылка, сумма. */
function normalizeH2h(data, fallbackAmount) {
  const row = data?.order || data || {};
  const rawStatus = String(row.status || data?.status || '').toLowerCase();

  let status = 'preparing';
  if (['paid', 'completed', 'success', 'succeeded'].includes(rawStatus)) status = 'paid';
  else if (['ready', 'pending', 'waiting', 'qr', 'created'].includes(rawStatus)) {
    status = row.qr || row.qr_data || row.qr_url || row.requisite ? 'ready' : 'preparing';
  }

  return {
    status,
    qr: row.qr || row.qr_data || row.requisite || row.requisites || null,
    qrImage: row.qr_image || row.qrImage || row.qr_url || null,
    paymentUrl: row.payment_url || row.paymentUrl || row.redirect_url || row.link || null,
    amount: Number(row.amount ?? fallbackAmount) || fallbackAmount,
    providerMessage: row.provider_message || row.message || null,
  };
}

/**
 * Достаёт из уведомления CloudPayments номер заказа и статус. Тело приходит
 * XML (по умолчанию) или JSON — в зависимости от настроек в личном кабинете.
 */
function parseCloudNotification(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  if (raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw);
      const row = data.Transaction || data.transaction || data;
      return {
        status: String(row.Status ?? row.status ?? ''),
        invoiceId: String(row.OrderId ?? row.InvoiceId ?? row.orderId ?? ''),
        accountId: String(row.AccountId ?? row.accountId ?? ''),
        amount: Number(row.Amount ?? row.amount) || null,
      };
    } catch {
      return null;
    }
  }

  const pick = (tag) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(raw);
    return m ? m[1].trim() : '';
  };
  return {
    status: pick('Status'),
    invoiceId: pick('OrderId') || pick('InvoiceId'),
    accountId: pick('AccountId'),
    amount: Number(pick('Amount')) || null,
  };
}

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
  // Цвет обводки панелек: контакты внизу главной и заглушка техработ.
  lineColor: '#ffc043',
  // Подписка: с ней ссылка живёт до subMaxTtlDays, без неё — subFreeTtlHours.
  subEnabled: false,
  subPriceRub: 290,
  subPeriodDays: 30,
  subMaxTtlDays: 30,
  subFreeTtlHours: 24,
  // Платёжная система. По умолчанию оплаты нет: подписку выдаёт админ.
  subProvider: 'manual',
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
 *
 * Если хранилище не отвечает, работаем на значениях по умолчанию: сайт
 * должен показать страницу с понятным предупреждением, а не отдавать 502
 * на каждый запрос — иначе при упавшем облаке не открывается вообще ничего.
 */
async function effectiveLimits(env, kv) {
  const base = limits(env);
  let settings = null;
  try {
    settings = await readSettings(kv);
  } catch (err) {
    console.error('settings unavailable, using defaults:', err?.message || err);
  }
  const merged = settings || { ...DEFAULT_SETTINGS, maintenance: true };
  return {
    settings: merged,
    settingsAvailable: !!settings,
    maxFileSize: clamp(Number(merged.maxFileSizeMb), 1, PLATFORM_MAX_MB) * 1024 * 1024,
    maxFiles: clamp(Number(merged.maxFilesPerUpload), 1, 10),
    defaultTtlHours: clamp(Number(merged.defaultTtlHours), 0, 24 * 365),
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

/** Цвет обводки от админа: приводим к #rrggbb, мусор заменяем запасным. */
function lineColorOf(value) {
  const hex = String(value || '').trim().replace(/^#/, '');
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : DEFAULT_SETTINGS.lineColor;
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

/* --------------------------- контакты --------------------------- */

/**
 * Контакты внизу главной. Хранятся так же, как заметки, но с коротким значением:
 * либо ссылка (с неё делаем кликабельный элемент), либо обычный текст.
 */
function normalizeContact(body) {
  const title = String(body?.title ?? '').trim().slice(0, 80);
  const rawValue = String(body?.value ?? '').trim().slice(0, 300);
  const kind = body?.kind === 'text' ? 'text' : 'link';
  if (!title || !rawValue) return null;

  // Ссылку приводим к виду, который безопасно открыть: только http и https.
  let value = rawValue;
  if (kind === 'link') {
    value = /^https?:\/\//i.test(rawValue) ? rawValue : `https://${rawValue.replace(/^\/+/, '')}`;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    } catch {
      return null;
    }
  }
  // Флажок «копировать по нажатию»: человек кликает по панельке и сразу
  // получает значение в буфер обмена, ничего запоминать не надо.
  return { title, value, kind, copyOnClick: body?.copyOnClick === true || body?.copyOnClick === 'true' };
}

async function listContacts(kv) {
  const { keys } = await kv.list(CONTACT_PREFIX, 100);
  const contacts = [];
  for (const key of keys) {
    const item = await kv.get(key);
    if (item) contacts.push(item);
  }
  return contacts.sort((a, b) => a.createdAt - b.createdAt);
}

/** Контакты для главной: без служебных полей и без кувыркающихся ссылок. */
function publicContacts(kv) {
  return listContacts(kv).then((list) =>
    list.map(({ id, title, value, kind, copyOnClick }) => ({ id, title, value, kind, copyOnClick: !!copyOnClick })),
  );
}

async function handleAdminContacts(request, env, kv) {
  const gate = await requireAdmin(request, env, kv);
  if (gate.error) return gate.error;

  const id = request.url.match(/\/api\/admin\/contacts\/([a-z0-9]{4,32})$/)?.[1];

  if (id) {
    if (request.method !== 'DELETE') return fail(405, 'Метод не поддерживается', 'method_not_allowed');
    const key = `${CONTACT_PREFIX}${id}`;
    if (!(await kv.get(key))) return fail(404, 'Контакт не найден', 'not_found');
    await kv.del(key);
    return json({ ok: true, deleted: id });
  }

  if (request.method === 'GET') return json({ ok: true, contacts: await listContacts(kv) });

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const contact = normalizeContact(body);
    if (!contact) return fail(400, 'Нужны название и значение контакта', 'bad_contact');

    const item = { id: newId(8), ...contact, createdAt: Date.now() };
    await kv.put(`${CONTACT_PREFIX}${item.id}`, item);
    return json({ ok: true, contact: item }, 201);
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
  // Цвет обводки: только нормальный hex, иначе страница осталась бы без цвета.
  if (body.lineColor !== undefined) {
    const hex = String(body.lineColor).trim().replace(/^#/, '');
    if (/^[\da-f]{6}$/i.test(hex)) patch.lineColor = `#${hex.toLowerCase()}`;
  }

  // Подписка
  if (body.subEnabled !== undefined) patch.subEnabled = !!body.subEnabled;
  if (body.subPriceRub !== undefined) patch.subPriceRub = clamp(Number(body.subPriceRub), 0, 1000000);
  if (body.subPeriodDays !== undefined) patch.subPeriodDays = clamp(Number(body.subPeriodDays), 1, 365);
  if (body.subMaxTtlDays !== undefined) patch.subMaxTtlDays = clamp(Number(body.subMaxTtlDays), 1, 365);
  if (body.subFreeTtlHours !== undefined) patch.subFreeTtlHours = clamp(Number(body.subFreeTtlHours), 1, 24 * 31);
  if (body.subProvider !== undefined && PAYMENT_PROVIDERS[body.subProvider]) patch.subProvider = body.subProvider;

  const settings = await writeSettings(kv, patch, gate.session.username);
  return json({ ok: true, settings });
}

/**
 * Подписка вручную: выдать, продлить или отозвать. Нужна, когда платёжная
 * система ещё не подключена или человек оплатил не через сайт.
 */
async function handleAdminSubscription(request, env, kv, storage, cfg) {
  const gate = await requireAdmin(request, env, kv);
  if (gate.error) return gate.error;
  if (request.method !== 'PUT') return fail(405, 'Метод не поддерживается', 'method_not_allowed');

  const body = await request.json().catch(() => null);
  const user = body?.login ? await findUser(kv, body.login) : null;
  if (!user) return fail(404, 'Пользователь с таким логином не найден', 'user_not_found');

  const sub = await subscriptionOf(kv, user.id) || {
    userId: user.id,
    username: user.username,
    active: false,
    startedAt: Date.now(),
    expiresAt: 0,
  };

  if (body.revoke) {
    const touched = await expireSubscription(storage, kv, cfg, sub);
    return json({ ok: true, revoked: true, files: touched });
  }

  const result = await activateSubscription(storage, kv, cfg, user, {
    days: Number(body.days) || cfg.settings.subPeriodDays,
    source: 'admin',
  });
  return json({ ok: true, subscription: result.record, restored: result.restored });
}

/** Список подписок для панели управления. */
async function handleAdminSubscriptions(request, env, kv) {
  const gate = await requireAdmin(request, env, kv);
  if (gate.error) return gate.error;

  const now = Date.now();
  const { keys } = await kv.list(SUB_PREFIX, 300);
  const list = [];
  for (const name of keys || []) {
    const record = await kv.get(name);
    if (!record) continue;
    list.push({
      username: record.username,
      active: subscriptionActive(record, now),
      expiresAt: record.expiresAt,
      source: record.source,
      amountRub: record.amountRub ?? null,
    });
  }
  list.sort((a, b) => Number(b.active) - Number(a.active) || (b.expiresAt || 0) - (a.expiresAt || 0));

  return json({
    ok: true,
    subscribers: list.filter((s) => s.active).length,
    expiringSoon: list.filter((s) => s.active && s.expiresAt - now < 3 * 24 * 3600 * 1000).length,
    list: list.slice(0, 100),
  });
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
  if (meta.userId) await removeFromUserIndex(kv, meta.userId, id).catch(() => {});
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

    // Хранилище может быть недоступно (бакет удалён, сеть). Главная тогда
    // всё равно отдаётся — с настройками по умолчанию и честной пометкой,
    // что сайт временно не может принимать файлы. Раньше здесь был 502,
    // и при неработающем хранилище страница оставалась пустой.
    let contacts = [];
    let storageDown = false;
    try {
      contacts = await publicContacts(kv);
    } catch (err) {
      storageDown = true;
      console.error('contacts unavailable:', err?.message || err);
    }

    let today = 0;
    try {
      today = await filesToday(kv);
    } catch {
      storageDown = true;
    }

    const state = storage.status();
    return json({
      files,
      listed,
      filesToday: today,
      maxFileSizeMb: Math.round(cfg.maxFileSize / 1024 / 1024),
      maxFiles: cfg.maxFiles,
      storage: { ...state, down: storageDown || state.authState === 'unreachable' },
      settings: {
        heroTitle: cfg.settings.heroTitle,
        heroLede: cfg.settings.heroLede,
        maintenance: cfg.settings.maintenance,
        allowRegistration: cfg.settings.allowRegistration,
        lineColor: lineColorOf(cfg.settings.lineColor),
        anonymousTtlHours: clamp(Number(cfg.settings.anonymousTtlHours ?? 1), 1, 24 * 30) || 1,
        subEnabled: !!cfg.settings.subEnabled,
        subPriceRub: Number(cfg.settings.subPriceRub) || 0,
        subPeriodDays: clamp(Number(cfg.settings.subPeriodDays), 1, 365),
      },
      ttlOptions: TTL_OPTIONS,
      defaultTtlHours: cfg.defaultTtlHours,
      auth: { enabled: true },
      contacts,
    });
  }

  /* --- подписка: состояние, оплата, вебхук --- */
  if (pathname.startsWith('/api/billing/')) {
    return handleBilling(request, env, kv, storage, cfg, url, pathname.slice('/api/billing/'.length));
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

  if (pathname === '/api/admin/subscription') {
    return handleAdminSubscription(request, env, kv, storage, cfg);
  }

  if (pathname.startsWith('/api/admin/contacts')) {
    return handleAdminContacts(request, env, kv);
  }

  if (pathname === '/api/admin/subscriptions') {
    return handleAdminSubscriptions(request, env, kv);
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
      background(ctx, bumpDailyCount(kv, meta.createdAt));
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
    background(ctx, bumpDailyCount(kv, meta.createdAt));
    return json({ ok: true, file: publicMeta(meta), links: linksFor(meta) });
  }

  /**
   * Ссылку создают после загрузки: срок жизни (и одноразовость) выбирают в
   * этом запросе, и только вместе с ответом появляется сама ссылка.
   */
  const linkMatch = /^\/api\/file\/([a-z0-9]{4,32})\/link$/.exec(pathname);
  if (linkMatch) {
    if (request.method !== 'POST' && request.method !== 'PATCH') {
      return fail(405, 'Метод не поддерживается', 'method_not_allowed');
    }

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

    // Гость срок не выбирает: он короткий и назначается сервером.
    const guest = !meta.userId;
    const sub = session ? await subscriptionOf(kv, session.userId) : null;
    const subscribed = subscriptionActive(sub);
    const rules = ttlOptionsFor(cfg, { guest, subscribed });

    const body = await request.json().catch(() => null);

    // Одноразовость можно поменять, пока по ссылке никто не скачал.
    if (body?.once !== undefined) {
      if (meta.downloads > 0 || meta.spentAt) {
        return fail(409, 'Ссылка уже использована — менять её нельзя', 'link_spent');
      }
      meta.once = !!body.once;
    }

    // Срок меняют только владельцу аккаунта: гостям он назначен.
    if (!guest) {
      const wantsTtl = body?.hours !== undefined || meta.ttlPending || request.method === 'PATCH';
      if (wantsTtl) {
        const hours = Number(body?.hours);
        const limit = subscribed ? rules.maxHours : rules.freeHours;

        // Явная ошибка в значении — это 400, превышение лимита — 403 с подсказкой.
        if (!Number.isFinite(hours) || hours < 1) {
          return fail(400, 'Срок должен быть числом часов не меньше 1', 'bad_ttl', { maxHours: limit });
        }
        if (!subscribed && hours > limit) {
          return fail(403, 'Такой срок доступен с подпиской', 'subscription_required', {
            maxHours: limit,
            subscription: { active: false },
          });
        }
        if (hours > limit) {
          return fail(400, `Срок должен быть от 1 часа до ${Math.round(limit / 24)} суток`, 'bad_ttl', { maxHours: limit });
        }

        // Задают один раз при создании ссылки; потом можно править из кабинета.
        if (meta.ttlPending || !meta.ttlHours) meta.ttlPending = false;
        meta.ttlHours = hours;
        meta.expiresAt = Date.now() + hours * 3600 * 1000;
        meta.ttlChosenAt = Date.now();
      }
    }

    await saveMeta(storage, meta);
    if (meta.userId) background(ctx, updateUserIndex(kv, meta.userId, meta));

    return json({
      ok: true,
      file: publicMeta(meta),
      links: linksFor(meta),
      subscription: { active: subscribed, expiresAt: sub?.expiresAt ?? null },
      ttl: rules,
    });
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
      // Индекс ждём здесь, а не в фоне: иначе кабинет успевает показать
      // только что удалённый файл, и он исчезает лишь после обновления страницы.
      if (byAccount) await removeFromUserIndex(kv, session.userId, id).catch(() => {});
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

/** Состояние подписки и правила сроков — для кабинета и формы загрузки. */
async function billingState(kv, env, cfg, session) {
  const sub = session ? await subscriptionOf(kv, session.userId) : null;
  const active = subscriptionActive(sub);
  const guest = !session;

  return {
    ok: true,
    subscription: {
      enabled: !!cfg.settings.subEnabled,
      active,
      expiresAt: sub?.expiresAt ?? null,
      startedAt: sub?.startedAt ?? null,
      priceRub: Number(cfg.settings.subPriceRub) || 0,
      periodDays: clamp(Number(cfg.settings.subPeriodDays), 1, 365),
      maxTtlDays: clamp(Number(cfg.settings.subMaxTtlDays), 1, 365),
      freeTtlHours: clamp(Number(cfg.settings.subFreeTtlHours ?? 24), 1, 24 * 31),
      ...paymentInfo(env, cfg),
    },
    ttl: ttlOptionsFor(cfg, { guest, subscribed: active }),
  };
}

/**
 * Подписка: создание заказа, реквизиты и статус. Провайдер выбран в панели.
 *
 *   checkout    — создать заказ (вход обязателен);
 *   requisites  — реквизиты для оплаты: QR, ссылка, сумма;
 *   status      — проверить, оплачено ли (страница оплаты спрашивает сама);
 *   webhook     — уведомление провайдера, если он его шлёт.
 */
async function handleBilling(request, env, kv, storage, cfg, url, action) {
  const session = action === 'webhook' ? null : await readSession(kv, request);
  const provider = providerOf(cfg);

  /* --- вебхук: провайдер сообщает об оплате сам --- */
  if (action === 'webhook') {
    if (request.method !== 'POST') return fail(405, 'Метод не поддерживается', 'method_not_allowed');

    const note = parseCloudNotification(await request.text().catch(() => ''));
    if (!note?.invoiceId) return json({ ok: true });
    if (note.status && note.status.toLowerCase() !== 'completed') return json({ ok: true });

    // Сверяем у CloudPayments её же API: свой вебхук никому нельзя подделать.
    if (provider === 'cloudpayments') {
      const check = await cloudpayments(env, '/payments/find', {
        method: 'POST',
        body: { InvoiceId: note.invoiceId },
      });
      if (!check.configured) return json({ ok: true });
      if (!check.ok || check.data?.Status !== 'Completed') return json({ ok: true });

      const userId = String(check.data.AccountId || note.accountId || '');
      const orderId = String(check.data.TransactionId ?? check.data.Id ?? note.invoiceId);
      const amountRub = Number(check.data.Amount) || null;
      const days = Number(check.data.Data?.periodDays ?? cfg.settings.subPeriodDays);
      const done = await settleOrder(storage, kv, cfg, invoiceUserId(check.data.Data?.userId, userId), {
        invoiceId: note.invoiceId,
        orderId,
        amountRub,
        days,
        source: 'cloudpayments',
      });
      return json({ ok: true, ...done });
    }

    // Универсальный вид: { order_id, status, account_id }
    const userId = String(note.accountId || '');
    const done = await settleOrder(storage, kv, cfg, userId, {
      invoiceId: note.invoiceId,
      orderId: note.invoiceId,
      amountRub: note.amount,
      days: cfg.settings.subPeriodDays,
      source: provider,
    });
    return json({ ok: true, ...done });
  }

  if (!session) return fail(401, 'Войдите в аккаунт', 'unauthorized');

  if (action === 'status') {
    return json(await billingState(kv, env, cfg, session));
  }

  /* --- создание заказа --- */
  if (action === 'checkout') {
    if (request.method !== 'POST') return fail(405, 'Метод не поддерживается', 'method_not_allowed');
    if (!cfg.settings.subEnabled) return fail(403, 'Оплата подписки сейчас выключена', 'sub_disabled');
    if (provider === 'manual') {
      return fail(403, 'Онлайн-оплата выключена: подписку выдаёт администратор', 'provider_manual');
    }
    if (!providerReady(env, cfg)) {
      return fail(503, 'Платёжная система не подключена — обратитесь к администратору', 'payment_not_configured');
    }

    const invoiceId = `sub-${session.userId}-${Date.now()}`;
    const order = orderPayload(cfg, session, invoiceId);

    if (provider === 'cloudpayments') {
      const created = await cloudpayments(env, '/orders/create', {
        method: 'POST',
        requestId: invoiceId,
        body: {
          Amount: order.amountRub.toFixed(2),
          Currency: 'RUB',
          Description: order.description,
          InvoiceId: invoiceId,
          AccountId: session.userId,
          SendEmail: false,
          Culture: 'ru-RU',
          Data: { userId: session.userId, periodDays: String(order.periodDays) },
        },
      });
      if (!created.configured) return fail(503, 'Платёжная система не подключена', 'payment_not_configured');
      if (!created.ok) return fail(502, created.error || 'Платёжная система не ответила', 'payment_error');

      const paymentUrl = created.data?.PaymentUrl || created.data?.paymentUrl || null;
      if (!paymentUrl) return fail(502, 'Платёжная система не вернула ссылку на оплату', 'payment_error');

      await kv.put(`${PAY_PREFIX}${invoiceId}`, { ...order, provider, createdAt: Date.now() });
      return json({ ok: true, provider, invoiceId, paymentUrl, amountRub: order.amountRub, periodDays: order.periodDays });
    }

    /* --- H2H: QR внутри нашей страницы --- */
    const created = await h2h(env, H2H_PATHS.create, {
      method: 'POST',
      body: {
        invoice_id: invoiceId,
        amount: order.amountRub.toFixed(2),
        currency: 'RUB',
        description: order.description,
        account_id: session.userId,
        metadata: { userId: session.userId, username: session.username, periodDays: String(order.periodDays) },
      },
    });
    if (!created.configured) return fail(503, 'Платёжная система не подключена', 'payment_not_configured');
    if (!created.ok) return fail(502, created.error || 'Платёжная система не ответила', 'payment_error');

    const norm = normalizeH2h(created.data, order.amountRub);
    const remoteId = String(created.data?.order?.id ?? created.data?.id ?? invoiceId);
    await kv.put(
      `${PAY_PREFIX}${invoiceId}`,
      { ...order, provider, remoteId, status: norm.status, createdAt: Date.now() },
    );

    return json({
      ok: true,
      provider,
      invoiceId,
      remoteId,
      amountRub: order.amountRub,
      periodDays: order.periodDays,
      requisites: norm,
    });
  }

  /* --- реквизиты для нашей страницы оплаты --- */
  if (action === 'requisites' || action === 'order') {
    const invoiceId = url.searchParams.get('invoice') || '';
    const order = invoiceId ? await kv.get(`${PAY_PREFIX}${invoiceId}`) : null;
    if (!order) return fail(404, 'Заказ не найден', 'order_not_found');

    // Чужой заказ не показываем: привязываем к владельцу сессии.
    if (order.accountId && order.accountId !== session.userId) {
      return fail(403, 'Это не ваш заказ', 'forbidden');
    }

    // Уже оплачено — просто подтверждаем.
    if (order.status === 'paid') {
      return json({ ok: true, status: 'paid', invoiceId, amountRub: order.amountRub });
    }

    if (order.provider === 'h2h') {
      const path = action === 'requisites'
        ? H2H_PATHS.requisites.replace('{id}', encodeURIComponent(order.remoteId || order.invoiceId))
        : H2H_PATHS.status.replace('{id}', encodeURIComponent(order.remoteId || order.invoiceId));

      const got = await h2h(env, path);
      if (!got.configured) return fail(503, 'Платёжная система не подключена', 'payment_not_configured');
      if (!got.ok) return json({ ok: true, status: 'preparing', message: got.error });

      const norm = normalizeH2h(got.data, order.amountRub);
      if (norm.status === 'paid') {
        const done = await settleOrder(storage, kv, cfg, order.accountId, {
          invoiceId: order.invoiceId,
          orderId: order.remoteId || order.invoiceId,
          amountRub: norm.amount,
          days: order.periodDays,
          source: 'h2h',
        });
        return json({ ok: true, status: 'paid', invoiceId, ...done });
      }

      await kv.put(`${PAY_PREFIX}${order.invoiceId}`, { ...order, status: norm.status, checkedAt: Date.now() });
      return json({ ok: true, invoiceId, ...norm });
    }

    // Для CloudPayments редиректом: просто отдаём сохранённую ссылку.
    return json({
      ok: true,
      status: order.status || 'ready',
      invoiceId,
      paymentUrl: order.paymentUrl ?? null,
      amountRub: order.amountRub,
    });
  }

  return fail(404, 'Неизвестный метод оплаты', 'not_found');
}

/** Идентификатор пользователя из данных заказа: разные провайдеры кладут его по-разному. */
function invoiceUserId(fromData, fallback) {
  return String(fromData || fallback || '');
}

/**
 * Подтверждаем оплату и включаем подписку. Повторный вызов с тем же заказом
 * ничего не делает — продлить дважды нельзя.
 */
async function settleOrder(storage, kv, cfg, userId, { invoiceId, orderId, amountRub, days, source }) {
  if (!userId) return { activated: false, reason: 'no_user' };

  const user = await kv.get(`${USER_PREFIX}${userId}`);
  if (!user) return { activated: false, reason: 'user_not_found' };

  const order = invoiceId ? await kv.get(`${PAY_PREFIX}${invoiceId}`) : null;
  if (order?.status === 'paid') return { activated: false, duplicate: true, expiresAt: order.paidAt };

  // Тот же платёж уже зачислен — не продлеваем второй раз.
  const sub = await subscriptionOf(kv, userId);
  if (sub?.orderId && sub.orderId === orderId) {
    if (order) await kv.put(`${PAY_PREFIX}${invoiceId}`, { ...order, status: 'paid', paidAt: Date.now() });
    return { activated: false, duplicate: true, expiresAt: sub.expiresAt };
  }

  const result = await activateSubscription(storage, kv, cfg, user, { days, orderId, amountRub, source });
  if (invoiceId) {
    await kv.put(`${PAY_PREFIX}${invoiceId}`, {
      ...(order || {}),
      invoiceId,
      accountId: userId,
      status: 'paid',
      paidAt: Date.now(),
      source,
    });
  }
  return { activated: true, expiresAt: result.record.expiresAt, restored: result.restored };
}

/** Дата по UTC в формате YYYY-MM-DD: под неё копим счётчик загрузок. */
function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Русское склонение: pluralRu(2, ['час', 'часа', 'часов']) → 'часа'. */
function pluralRu(n, forms) {
  const abs = Math.abs(Number(n) || 0) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

/* ----------------------------- подписка ----------------------------- */

const SUB_PREFIX = 'sub/';
const PAY_PREFIX = 'pay/';
const CONTACT_PREFIX = 'contacts/';

/** Запись подписки пользователя или null. */
async function subscriptionOf(kv, userId) {
  if (!userId) return null;
  return (await kv.get(`${SUB_PREFIX}${userId}`)) || null;
}

/** Подписка активна, если её не отозвали и срок не истёк. */
function subscriptionActive(sub, now = Date.now()) {
  return !!sub && sub.active !== false && sub.expiresAt > now;
}

/**
 * Что можно выбрать по сроку жизни.
 *
 *   гость без аккаунта — фиксированный короткий срок, выбирать нечего;
 *   пользователь без подписки — subFreeTtlHours (по умолчанию сутки);
 *   подписчик — любой из вариантов до subMaxTtlDays.
 *
 * «Навсегда» больше не предлагаем: срок ограничен подпиской.
 */
function ttlOptionsFor(cfg, { guest, subscribed }) {
  const anonHours = clamp(Number(cfg.settings.anonymousTtlHours ?? 1), 1, 24 * 30) || 1;
  const freeHours = clamp(Number(cfg.settings.subFreeTtlHours ?? 24), 1, 24 * 31) || 24;
  const maxDays = clamp(Number(cfg.settings.subMaxTtlDays ?? 30), 1, 365) || 30;

  if (guest) {
    return { options: [{ hours: anonHours, label: `${anonHours} ч` }], maxHours: anonHours, freeHours, selectable: false };
  }

  if (!subscribed) {
    const days = Math.max(1, Math.round(freeHours / 24));
    const label =
      freeHours % 24 === 0 ? `${days} ${pluralRu(days, ['сутки', 'суток', 'суток'])}` : `${freeHours} ч`;
    return { options: [{ hours: freeHours, label }], maxHours: freeHours, freeHours, selectable: false };
  }

  const wanted = [1, 24, 168, maxDays * 24].filter((h) => h <= maxDays * 24 && h >= 1);
  const unique = [...new Set(wanted)].sort((a, b) => a - b);
  const labels = { 1: '1 час', 24: '24 часа', 168: '7 дней' };
  return {
    options: unique.map((h) => ({
      hours: h,
      label: labels[h] ?? `${Math.round(h / 24)} ${pluralRu(Math.round(h / 24), ['день', 'дня', 'дней'])}`,
    })),
    maxHours: maxDays * 24,
    freeHours,
    selectable: true,
  };
}

/**
 * Включает или продлевает подписку и возвращает файлам выбранные сроки:
 * человек оплатил — сроки, которые он выбирал сам, снова действуют.
 */
async function activateSubscription(storage, kv, cfg, user, { days, orderId = null, amountRub = null, source = 'admin' }) {
  const now = Date.now();
  const period = clamp(Number(days ?? cfg.settings.subPeriodDays), 1, 365) || 30;
  const previous = await subscriptionOf(kv, user.id);

  // Продление считаем от конца текущего срока, а не от сегодня.
  const base = subscriptionActive(previous, now) ? previous.expiresAt : now;

  const record = {
    userId: user.id,
    username: user.username,
    active: true,
    startedAt: previous?.startedAt ?? now,
    expiresAt: base + period * 24 * 3600 * 1000,
    orderId,
    amountRub,
    source,
    updatedAt: now,
  };
  await kv.put(`${SUB_PREFIX}${user.id}`, record);

  // Возвращаем файлам тот срок, который человек выбирал сам.
  const index = (await kv.get(`${INDEX_PREFIX}${user.id}`)) || [];
  let restored = 0;
  for (const entry of index) {
    const meta = await readMeta(storage, entry.id);
    if (!meta || !meta.ttlHours) continue;
    meta.expiresAt = now + meta.ttlHours * 3600 * 1000;
    meta.restoredAt = now;
    await saveMeta(storage, meta);
    entry.expiresAt = meta.expiresAt;
    restored += 1;
  }
  if (restored) await kv.put(`${INDEX_PREFIX}${user.id}`, index);

  return { record, restored };
}

/**
 * Подписка кончилась: сроки файлов срезаются до бесплатных, но выбранные
 * человеком часы сохраняются — вернём их, если он снова оплатит.
 */
async function expireSubscription(storage, kv, cfg, record) {
  const now = Date.now();
  const freeMs = (clamp(Number(cfg.settings.subFreeTtlHours ?? 24), 1, 24 * 31) || 24) * 3600 * 1000;
  const limit = now + freeMs;

  const index = (await kv.get(`${INDEX_PREFIX}${record.userId}`)) || [];
  let touched = 0;
  for (const entry of index) {
    const meta = await readMeta(storage, entry.id);
    if (!meta) continue;
    if (meta.expiresAt && meta.expiresAt <= limit) continue;
    meta.expiresAt = limit;
    meta.downgradedAt = now;
    await saveMeta(storage, meta);
    entry.expiresAt = limit;
    touched += 1;
  }
  if (touched) await kv.put(`${INDEX_PREFIX}${record.userId}`, index);

  await kv.put(`${SUB_PREFIX}${record.userId}`, { ...record, active: false, expiredAt: now, updatedAt: now });
  return touched;
}

/** Кто ещё платит: записи с истёкшим сроком обновляем по расписанию. */
async function sweepSubscriptions(storage, kv, cfg) {
  const now = Date.now();
  let expired = 0;
  let files = 0;

  const { keys } = await kv.list(SUB_PREFIX, 200);
  for (const name of keys || []) {
    if (!name.startsWith(SUB_PREFIX)) continue;
    const record = await kv.get(name);
    if (!record || !record.active) continue;
    if (record.expiresAt > now) continue;
    files += await expireSubscription(storage, kv, cfg, record);
    expired += 1;
  }
  return { expired, files };
}

/**
 * Считает загрузки за сутки. Счётчик хранится отдельно от файлов, поэтому
 * чистка просроченного не обнуляет статистику за день. Старые дни убираем,
 * чтобы в бакете не копились мелкие записи.
 */
async function bumpDailyCount(kv, ts = Date.now()) {
  const key = `${STATS_PREFIX}${dayKey(ts)}`;
  const next = (Number((await kv.get(key)) || 0) || 0) + 1;
  await kv.put(key, next);

  try {
    const cutoff = dayKey(ts - 30 * 24 * 3600 * 1000);
    const { keys } = await kv.list(STATS_PREFIX, 60);
    for (const item of keys || []) {
      const name = typeof item === 'string' ? item : item.name || item.key;
      if (!name || !name.startsWith(STATS_PREFIX)) continue;
      const day = name.slice(STATS_PREFIX.length).replace(/\.json$/, '');
      if (day && day < cutoff) await kv.del(name);
    }
  } catch {
    /* чистка старых дней — не критично */
  }

  return next;
}

async function filesToday(kv) {
  return Number((await kv.get(`${STATS_PREFIX}${dayKey()}`)) || 0) || 0;
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

/**
 * Любая ошибка хранилища в маршрутах API превращается в понятный ответ.
 * Без этого человек видел «Хранилище недоступно» с кодом 502 и думал, что
 * сломан пароль: на самом деле не работало хранилище.
 */
function apiFailure(err) {
  if (err instanceof StorageError) {
    const friendly = err.code === 'storage_unreachable'
      ? 'Хранилище временно недоступно, мы чиним. Попробуйте через минуту.'
      : err.message;
    return fail(err.status, friendly, err.code, { hint: err.hint, detail: err.detail });
  }
  if (/fetch failed|dns|network|getaddrinfo/i.test(String(err?.message || ''))) {
    return fail(502, 'Хранилище временно недоступно, мы чиним. Попробуйте через минуту.', 'storage_unreachable');
  }
  console.error('api error:', err?.message || err);
  return fail(500, 'Внутренняя ошибка', 'internal_error');
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
        let res;
        try {
          res = await handleApi(request, env, url, createStorage(env), createKv(env), ctx);
        } catch (err) {
          // Упавшее хранилище не должно выглядеть как «неверный пароль».
          res = apiFailure(err);
        }
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
        for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
        const connect = connectSources(env);
        headers.set('content-security-policy', buildCsp(connect ? ` ${connect}` : ''));
        return new Response(res.body, { status: res.status, headers });
      }

      // Ссылка вида /f/<id> отдавалась совсем без стилей: страница приходила
      // из SPA-заглушки, а относительные пути к CSS уезжали в /f/styles.css.
      // Отправляем такой запрос на канонический вид /#/f/<id>.
      if (/^\/f\/[A-Za-z0-9._-]{1,64}$/.test(url.pathname)) {
        return new Response(null, {
          status: 302,
          headers: { ...documentHeaders(env), location: `/#${url.pathname}` },
        });
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
    const kv = createKv(env);
    ctx.waitUntil(
      (async () => {
        const cfg = await effectiveLimits(env, kv);
        // Подписки, которые кончились: сроки файлов срезаются до бесплатных.
        const subs = await sweepSubscriptions(storage, kv, cfg);
        if (subs.expired) console.log(`подписок истекло: ${subs.expired}, файлов обрезано: ${subs.files}`);
        const removed = await cleanup(storage, kv).catch((err) => {
          console.warn('cleanup failed:', err?.message || err);
          return 0;
        });
        if (removed) console.log(`просроченных файлов удалено: ${removed}`);
      })(),
    );
  },
};