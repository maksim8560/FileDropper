/**
 * Слой хранения файлов.
 *
 * Основной провайдер — Upstash Blob (S3-совместимое хранилище, REST API).
 * Если токен не задан или хранилище отвечает ошибкой авторизации,
 * автоматически включается аварийный режим (память воркера) — сайт остаётся
 * работоспособным, но файлы живут только до перезапуска инстанса.
 */

const DEFAULT_BLOB_URL = 'https://b2e0533cedea.blob.upstash.io';

export class StorageError extends Error {
  constructor(message, { status = 502, code = 'storage_error', hint = null } = {}) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/** Экранируем каждый сегмент пути, но сохраняем слэши как есть. */
function encodeKey(key) {
  return String(key)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

class BaseStorage {
  constructor() {
    this.provider = 'memory';
    this.lastError = null;
    this.authState = 'unknown'; // unknown | ok | unauthorized
  }

  get degraded() {
    return this.provider !== 'upstash-blob';
  }

  status() {
    return {
      provider: this.provider,
      degraded: this.degraded,
      authState: this.authState,
      lastError: this.lastError,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Upstash Blob                                                      */
/* ------------------------------------------------------------------ */
class BlobStorage extends BaseStorage {
  constructor(url, token) {
    super();
    this.provider = 'upstash-blob';
    this.base = url.replace(/\/+$/, '');
    this.token = token;
  }

  headers(extra = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  fail(res, action) {
    if (res.status === 401 || res.status === 403) {
      this.authState = 'unauthorized';
      this.lastError = `Upstash Blob отклонил токен (HTTP ${res.status}) при операции «${action}»`;
      return new StorageError('Хранилище отклонило токен доступа', {
        status: 502,
        code: 'blob_unauthorized',
        hint: 'Проверьте секрет UPSTASH_BLOB_TOKEN (wrangler secret put UPSTASH_BLOB_TOKEN) и права токена на запись.',
      });
    }
    this.lastError = `Upstash Blob: HTTP ${res.status} при операции «${action}»`;
    return new StorageError(this.lastError, { status: 502, code: 'blob_error' });
  }

  /** PUT-подобная загрузка: POST /upload с заголовком x-upstash-blob-filename. */
  async put(key, value, { contentType = 'application/octet-stream' } = {}) {
    const res = await fetch(`${this.base}/upload`, {
      method: 'POST',
      headers: this.headers({ 'x-upstash-blob-filename': key, 'content-type': contentType }),
      body: value,
    });

    if (!res.ok) throw this.fail(res, `загрузка ${key}`);

    this.authState = 'ok';
    this.lastError = null;

    let info = {};
    try {
      info = await res.json();
    } catch {
      /* Upstash всегда отдаёт JSON, но подстрахуемся */
    }
    return { key: info.pathname || key, url: info.url || `${this.base}/${key}` };
  }

  /** Чтение: сначала с токеном, при 401 — ещё раз анонимно (публичный бакет). */
  async get(key, { range = null } = {}) {
    const url = `${this.base}/${encodeKey(key)}`;
    const rangeHeader = range ? { range } : {};

    let res = await fetch(url, { headers: this.headers(rangeHeader) });

    if (res.status === 401 || res.status === 403) {
      res = await fetch(url, { headers: range ? { range } : {} });
    }

    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok && res.status !== 206) throw this.fail(res, `чтение ${key}`);

    this.authState = res.status === 401 ? this.authState : 'ok';

    return {
      body: res.body,
      status: res.status,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      contentLength: res.headers.get('content-length'),
      contentRange: res.headers.get('content-range'),
      acceptRanges: res.headers.get('accept-ranges'),
      etag: res.headers.get('etag'),
    };
  }

  async del(key) {
    const res = await fetch(`${this.base}/delete`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ keys: [key] }),
    });
    if (!res.ok) throw this.fail(res, `удаление ${key}`);
    return true;
  }

  async list(prefix = '', limit = 200) {
    const res = await fetch(`${this.base}/list`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefix, limit }),
    });
    if (!res.ok) throw this.fail(res, `список ${prefix || '*'}`);

    this.authState = 'ok';
    const data = await res.json().catch(() => ({}));
    return { blobs: Array.isArray(data.blobs) ? data.blobs : [], cursor: data.cursor ?? null };
  }

  /** Проверка живости хранилища (для /api/health и UI-статуса). */
  async ping() {
    try {
      await this.list('', 1);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code ?? null };
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Аварийный режим: память воркера                                    */
/* ------------------------------------------------------------------ */
class MemoryStorage extends BaseStorage {
  constructor(reason = 'Токен хранилища не задан') {
    super();
    this.reason = reason;
    this.authState = 'memory';
    this.map = new Map();
    this.bytes = 0;
  }

  async put(key, value, { contentType = 'application/octet-stream' } = {}) {
    const buf = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer());
    this.map.set(key, {
      body: buf,
      contentType,
      uploadedAt: new Date().toISOString(),
      size: buf.byteLength,
    });
    this.bytes += buf.byteLength;
    return { key, url: null };
  }

  async get(key, { range = null } = {}) {
    const item = this.map.get(key);
    if (!item) return null;

    let slice = item.body;
    let status = 200;
    let contentRange = null;

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), item.body.byteLength - 1) : item.body.byteLength - 1;
        if (start <= end && start < item.body.byteLength) {
          slice = item.body.subarray(start, end + 1);
          status = 206;
          contentRange = `bytes ${start}-${end}/${item.body.byteLength}`;
        }
      }
    }

    return {
      body: slice,
      status,
      contentType: item.contentType,
      contentLength: String(slice.byteLength),
      contentRange,
      acceptRanges: 'bytes',
      etag: `W/"${item.size}-${item.uploadedAt}"`,
    };
  }

  async del(key) {
    const item = this.map.get(key);
    if (item) {
      this.bytes -= item.size;
      this.map.delete(key);
    }
    return true;
  }

  async list(prefix = '', limit = 200) {
    const blobs = [];
    for (const [key, item] of this.map) {
      if (key.startsWith(prefix)) {
        blobs.push({ pathname: key, uploadedAt: item.uploadedAt, size: item.size });
      }
      if (blobs.length >= limit) break;
    }
    return { blobs, cursor: null };
  }

  async ping() {
    return { ok: false, error: this.reason, code: 'memory_mode' };
  }
}

/* ------------------------------------------------------------------ */

// Аварийный режим держится в памяти изолята, поэтому инстанс должен быть
// один на запросы — иначе Map очищается между вызовами.
let cached = null;
let cachedKey = '';

/**
 * Выбирает провайдера: токен есть → Blob, иначе память.
 * Результат кэшируется на время жизни изолята.
 */
export function createStorage(env = {}) {
  const token = (env.UPSTASH_BLOB_TOKEN || '').trim();
  const url = (env.UPSTASH_BLOB_URL || DEFAULT_BLOB_URL).trim();
  const key = `${url}|${token ? token.slice(0, 12) : 'memory'}`;

  if (cached && cachedKey === key) return cached;

  cached = token ? new BlobStorage(url, token) : new MemoryStorage('UPSTASH_BLOB_TOKEN не задан — работает аварийный режим');
  cachedKey = key;
  return cached;
}