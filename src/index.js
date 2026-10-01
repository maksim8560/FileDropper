/**
 * Файлообменник — Cloudflare Worker (API + статика).
 *
 * API:
 *   GET    /api/stats              — статистика и состояние хранилища
 *   GET    /api/health             — диагностика хранилища
 *   POST   /api/upload             — загрузка одного файла (multipart)
 *   GET    /api/file/:id           — метаданные файла (JSON)
 *   GET    /api/file/:id?dl=1      — скачивание файла (поток, поддержка Range)
 *   GET    /api/raw/:id            — сырой поток для превью
 *   DELETE /api/file/:id           — удаление файла (нужен x-owner-token)
 *
 * Вся статика отдаётся из биндинга ASSETS с SPA-fallback.
 */

import { createStorage, StorageError } from './storage.js';

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
  'content-security-policy': [
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
    "connect-src 'self'",
  ].join('; '),
};

/**
 * CORS: фронт живёт на GitHub Pages, API — здесь, поэтому домены разные.
 * Открываем все источники: авторизации по кукам нет, токен владельца файла
 * передаётся явно заголовком, поэтому wildcard здесь безопасен.
 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, x-owner-token',
  'access-control-expose-headers': 'content-length, content-range, content-disposition, x-file-name, accept-ranges',
  'access-control-max-age': '86400',
};

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // без похожих символов (0/o, 1/l)
const META_PREFIX = 'm/';
const FILE_PREFIX = 'f/';

const limits = (env) => ({
  maxFileSize: Math.max(1, Number(env.MAX_FILE_SIZE_MB) || 25) * 1024 * 1024,
  maxFiles: Math.max(1, Number(env.MAX_FILES_PER_UPLOAD) || 4),
  defaultTtlHours: Number(env.DEFAULT_TTL_HOURS ?? 24),
});

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
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

/** Имя для ключа в хранилище: ASCII-транслитерация, чтобы заголовки не ломались. */
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

/** Имя для показа и заголовка Content-Disposition. */
function displayName(name) {
  const cleaned = String(name)
    .replace(/[\u0000-\u001f\u007f\\/]/g, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'file';
}

function contentDisposition(name, inline = false) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function sha(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Грубый лимитер запросов на IP: окно в миллисекундах и максимум попыток. */
function rateLimiter(windowMs, max) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear(); // страховка от роста памяти в долгоживущем изоляте
    return true;
  };
}

const allowUpload = rateLimiter(10 * 60 * 1000, 60); // 60 файлов за 10 минут с одного IP

/** Запускаем фоном, не дожидаясь ответа клиенту. */
function background(promise) {
  Promise.resolve(promise).catch((err) => console.warn('background task failed:', err?.message || err));
}

/* --------------------------- маршрутизация -------------------------- */

async function handleApi(request, env, url, storage) {
  const { pathname } = url;
  const cfg = limits(env);

  /* --- диагностика --- */
  if (pathname === '/api/health') {
    const ping = storage.ping ? await storage.ping() : { ok: false };
    return json({ ok: ping.ok === true, storage: storage.status(), ping });
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
      storage: storage.status(),
      ttlOptions: [
        { hours: 1, label: '1 час' },
        { hours: 24, label: '24 часа' },
        { hours: 168, label: '7 дней' },
        { hours: 0, label: 'Навсегда' },
      ],
      defaultTtlHours: cfg.defaultTtlHours,
    });
  }

  /* --- загрузка --- */
  if (pathname === '/api/upload') {
    if (request.method !== 'POST') return fail(405, 'Метод не поддерживается', 'method_not_allowed');

    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (!allowUpload(ip)) return fail(429, 'Слишком много загрузок. Подождите несколько минут.', 'rate_limited');

    const declared = Number(request.headers.get('content-length') || 0);
    if (declared && declared > cfg.maxFileSize + 512 * 1024) {
      return fail(413, `Файл больше лимита ${cfg.maxFileSize / 1024 / 1024} МБ`, 'too_large');
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return fail(400, 'Не удалось разобрать запрос', 'bad_form');
    }

    const file = form.get('file');
    if (!file || typeof file === 'string') return fail(400, 'Файл не передан', 'no_file');
    if (file.size === 0) return fail(400, 'Файл пустой', 'empty_file');
    if (file.size > cfg.maxFileSize) {
      return fail(413, `Файл больше лимита ${cfg.maxFileSize / 1024 / 1024} МБ`, 'too_large');
    }

    const once = form.get('once') === '1' || form.get('once') === 'true';
    const ttlRaw = form.get('ttl');
    const hours = ttlRaw === '' || ttlRaw === null ? cfg.defaultTtlHours : Number(ttlRaw);
    const ttlHours = Number.isFinite(hours) && hours >= 0 ? hours : cfg.defaultTtlHours;

    const now = Date.now();
    const id = newId();
    const name = displayName(file.name);
    const key = `${FILE_PREFIX}${id}/${asciiSlug(name)}`;
    const ownerToken = form.get('ownerToken')?.toString() || newId(24);
    const owner = (await sha(ownerToken)).slice(0, 32);

    const meta = {
      id,
      name,
      key,
      size: file.size,
      type: (file.type || 'application/octet-stream').slice(0, 120),
      createdAt: now,
      expiresAt: ttlHours > 0 ? now + ttlHours * 3600 * 1000 : null,
      once,
      downloads: 0,
      lastDownloadAt: null,
      owner,
    };

    try {
      // Потоковая загрузка: тело файла не дублируется в памяти воркера.
      await storage.put(key, file.stream(), { contentType: meta.type });
      await storage.put(`${META_PREFIX}${id}.json`, JSON.stringify(meta), {
        contentType: 'application/json; charset=utf-8',
      });
    } catch (err) {
      if (err instanceof StorageError) return fail(err.status, err.message, err.code, { hint: err.hint });
      return fail(502, 'Не удалось сохранить файл', 'storage_error');
    }

    return json({ ok: true, file: publicMeta(meta), links: { page: `/f/${id}`, download: `/api/file/${id}?dl=1`, raw: `/api/raw/${id}` } }, 201);
  }

  /* --- конкретный файл --- */
  const fileMatch = /^\/api\/file\/([a-z0-9]{4,32})$/.exec(pathname);
  if (fileMatch) {
    const id = fileMatch[1];
    const meta = await readMeta(storage, id);
    if (!meta) return fail(404, 'Файл не найден — ссылка неверная или файл уже удалён', 'not_found');

    if (isExpired(meta)) {
      background(removeFile(storage, meta));
      return fail(410, 'Срок хранения файла истёк', 'expired');
    }

    // Одноразовая ссылка уже погашена: payload удалён, но «надгробие» живёт,
    // чтобы получатель увидел внятную причину, а не «файл не найден».
    if (meta.spentAt || (meta.once && meta.downloads > 0)) {
      return fail(410, 'Одноразовая ссылка уже использована — файл удалён после первого скачивания', 'link_spent');
    }

    if (request.method === 'DELETE') {
      const token = request.headers.get('x-owner-token') || '';
      if (!(await sha(token)).startsWith(meta.owner)) {
        return fail(403, 'Нужен токен владельца файла', 'forbidden');
      }
      await removeFile(storage, meta);
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
      // Одноразовая ссылка: отдаём байты и удаляем сам файл, оставляя метку.
      meta.spentAt = Date.now();
      background(deletePayload(storage, meta).then(() => saveMeta(storage, meta)));
    } else {
      background(saveMeta(storage, meta));
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
      background(removeFile(storage, meta));
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
  };
}

function isExpired(meta) {
  return !!meta.expiresAt && meta.expiresAt < Date.now();
}

async function readMeta(storage, id) {
  try {
    const data = await storage.get(`${META_PREFIX}${id}.json`);
    if (!data) return null;
    return JSON.parse(await new Response(data.body).text());
  } catch {
    return null;
  }
}

function saveMeta(storage, meta) {
  return storage.put(`${META_PREFIX}${meta.id}.json`, JSON.stringify(meta), {
    contentType: 'application/json; charset=utf-8',
  });
}

function removeFile(storage, meta) {
  return Promise.all([deletePayload(storage, meta), storage.del(`${META_PREFIX}${meta.id}.json`)]);
}

/** Удаляет только сам файл, оставляя метаданные (для «надгробий»). */
function deletePayload(storage, meta) {
  return storage.del(meta.key);
}

/** Чистка просроченных файлов и «надгробий» по cron-триггеру. */
async function cleanupExpired(storage) {
  const { blobs } = await storage.list(META_PREFIX, 500);
  const tombstoneTtl = 24 * 3600 * 1000;
  let removed = 0;
  for (const item of blobs) {
    const key = item.pathname || item.key;
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
      removed += 1;
    }
  }
  return removed;
}

/* ------------------------------ Worker ------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Preflight для кросс-доменной загрузки с GitHub Pages
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        const res = await handleApi(request, env, url, createStorage(env));
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
        for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }

      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
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
    ctx.waitUntil(
      cleanupExpired(storage).catch((err) => console.warn('cleanup failed:', err?.message || err)),
    );
  },
};