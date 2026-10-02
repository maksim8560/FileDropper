/**
 * Слой хранения файлов.
 *
 * Основной провайдер — Upstash Blob через официальный клиент @upstash/blob.
 * Важно: сам бакет живёт за Cloudflare R2, и данные-plane ходит по S3-совместимому
 * API с подписью SigV4 (временные креды выдаёт Upstash-агент). Поэтому «сырые»
 * запросы вида POST /upload с Bearer-токеном не работают — 401 от R2.
 * Официальный SDK делает это правильно, в том числе на Cloudflare Workers.
 *
 * Если токен не задан или хранилище отвечает ошибкой авторизации, автоматически
 * включается аварийный режим (память воркера) — сайт остаётся работоспособным,
 * но файлы живут только до перезапуска инстанса.
 */

import { Bucket } from '@upstash/blob';

const DEFAULT_BLOB_URL = 'https://b2e0533cedea.blob.upstash.io';

export class StorageError extends Error {
  constructor(message, { status = 502, code = 'storage_error', hint = null, detail = null } = {}) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.detail = detail;
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
    this.bucket = new Bucket({ token, url: this.base });
  }

  /** Любая ошибка от хранилища превращается в понятный StorageError. */
  fail(err, action) {
    const status = err?.status ?? err?.statusCode ?? err?.response?.status ?? null;
    // Тело ответа важно не меньше статуса: по нему видно, что именно сказал
    // Upstash. Раньше сюда попадало «[object Object]» — отлаживать было нечем.
    const body = typeof err?.body === 'string' ? err.body.slice(0, 200) : '';
    const raw = [String(err?.message || '').slice(0, 160), body].filter(Boolean).join(' — ').slice(0, 240) || 'без ответа';

    if (err?.name === 'TypeError' || /fetch failed|network|dns|enotfound/i.test(raw)) {
      this.authState = 'unreachable';
      this.lastError = `Хранилище недоступно во время операции «${action}»: ${raw}`;
      return new StorageError('Хранилище недоступно', {
        status: 502,
        code: 'storage_unreachable',
        detail: this.lastError,
        hint: 'Проверьте, что бакет Upstash создан, а в vars.UPSTASH_BLOB_URL указан его адрес.',
      });
    }

    if (status === 401 || status === 403 || /unauthorized|forbidden/i.test(raw)) {
      this.authState = 'unauthorized';
      this.lastError = `Upstash Blob отклонил токен при операции «${action}»${status ? ` (HTTP ${status})` : ''} — ${raw}`;
      return new StorageError('Хранилище отклонило токен доступа', {
        status: 502,
        code: 'blob_unauthorized',
        detail: raw,
        hint: 'Проверьте секрет UPSTASH_BLOB_TOKEN (wrangler secret put UPSTASH_BLOB_TOKEN) и URL бакета в vars.UPSTASH_BLOB_URL.',
      });
    }

    if (status === 404 || /not found/i.test(raw)) {
      const notFound = new StorageError('Файл не найден в хранилище', { status: 404, code: 'not_found' });
      return notFound;
    }

    this.lastError = `Upstash Blob: ${raw}`;
    return new StorageError(this.lastError, { status: 502, code: 'blob_error' });
  }

  ok() {
    this.authState = 'ok';
    this.lastError = null;
  }

  /**
   * Запись идёт по подписанной ссылке, а PUT делаем своим fetch.
   *
   * Почему не bucket.put(): внутри Cloudflare Workers собственный PUT-путь SDK
   * отваливается с 403 «Signature mismatch» (подпись не сходится с тем, что
   * отправляет рантайм). Подпись та же, тело то же — работает. Проверено
   * диагностикой: sdk.put → 403, signedUrl + fetch → 200.
   */
  async put(key, value, { contentType = 'application/octet-stream', size = null } = {}) {
    try {
      let body = value;
      let length = size;
      if (typeof value === 'string') {
        body = value;
        length = new TextEncoder().encode(value).byteLength;
      } else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        length = value.byteLength;
      }

      const signed = await this.bucket.signedUploadUrl(encodeKey(key), {
        contentType,
        size: length ?? undefined,
        expiresIn: 300,
      });

      const res = await fetch(signed.url, {
        method: 'PUT',
        headers: signed.headers,
        body,
      });

      if (!res.ok) {
        return this.fail({ status: res.status }, `загрузка ${key}`);
      }

      this.ok();
      return { key, url: `${this.base}/${encodeKey(key)}` };
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw this.fail(err, `загрузка ${key}`);
    }
  }

  /**
   * Чтение идёт обычным GET по публичному адресу объекта: так нативно
   * работает Range (перемотка видео/аудио) и ответ отдаётся потоком.
   *
   * Обязательно отключаем кэш: Upstash Blob отдаёт объекты с `max-age=3600`,
   * поэтому CDN ещё час отдавал бы уже удалённые файлы — и «одноразовая
   * ссылка» была бы не одноразовой. Плюс счётчик скачиваний и удаление
   * не были бы видны сразу.
   *
   * Если бакет станет приватным — пробуем с токеном.
   */
  async get(key, { range = null } = {}) {
    const url = `${this.base}/${encodeKey(key)}?nc=${Date.now()}`;
    const headers = { 'cache-control': 'no-cache', ...(range ? { range } : {}) };

    let res;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${this.token}`, ...headers } });
      if (res.status === 401 || res.status === 403) {
        res = await fetch(url, { headers });
      }
    } catch (err) {
      // Сеть/DNS/таймаут: раньше эта ошибка улетала наружу сырым TypeError.
      throw this.fail(err, `чтение ${key}`);
    }

    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok && res.status !== 206) {
      throw this.fail({ status: res.status, body: await res.text().catch(() => '') }, `чтение ${key}`);
    }

    this.ok();
    return {
      body: res.body,
      status: res.status === 206 ? 206 : 200,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      contentLength: res.headers.get('content-length'),
      contentRange: res.headers.get('content-range'),
      acceptRanges: res.headers.get('accept-ranges') || 'bytes',
      etag: res.headers.get('etag'),
    };
  }

  /**
   * Подписанная ссылка на прямую загрузку: Worker только подписывает,
   * а байты кладёт браузер. Так работает и быстрее (файл не идёт через
   * Worker), и без лимита Cloudflare на тело запроса.
   */
  async signedUpload(key, contentType, size) {
    try {
      const signed = await this.bucket.signedUploadUrl(encodeKey(key), {
        contentType,
        size,
        expiresIn: 900,
      });
      this.ok();
      return { url: signed.url, headers: signed.headers ?? {} };
    } catch (err) {
      throw this.fail(err, `подпись ссылки ${key}`);
    }
  }

  async del(key) {
    try {
      await this.bucket.del(encodeKey(key));
      this.ok();
      return true;
    } catch (err) {
      if (/not found|404/i.test(String(err?.message || err))) return true;
      throw this.fail(err, `удаление ${key}`);
    }
  }

  async list(prefix = '', limit = 200) {
    try {
      const res = await this.bucket.list({ prefix, limit });
      this.ok();
      return { blobs: res.blobs ?? [], cursor: res.cursor ?? null };
    } catch (err) {
      throw this.fail(err, `список ${prefix || '*'}`);
    }
  }

  /** Проверка живости хранилища (для /api/health и плашки в интерфейсе). */
  async ping() {
    try {
      await this.bucket.list({ limit: 1 });
      this.ok();
      return { ok: true };
    } catch (err) {
      const wrapped = this.fail(err, 'проверка связи');
      return { ok: false, error: wrapped.message, code: wrapped.code };
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
    const buf =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(await new Response(value).arrayBuffer());
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

  /** В аварийном режиме подписывать нечего: файл приходит через /api/upload. */
  async signedUpload() {
    return null;
  }

  async list(prefix = '', limit = 200) {
    const blobs = [];
    for (const [key, item] of this.map) {
      if (key.startsWith(prefix)) {
        blobs.push({ pathname: key, path: key, uploadedAt: item.uploadedAt, size: item.size });
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
 * Выбирает провайдера: токен есть → Upstash Blob, иначе память.
 * Результат кэшируется на время жизни изолята.
 */
export function createStorage(env = {}) {
  const token = (env.UPSTASH_BLOB_TOKEN || '').trim();
  const url = (env.UPSTASH_BLOB_URL || DEFAULT_BLOB_URL).trim();
  const key = `${url}|${token ? token.slice(0, 12) : 'memory'}`;

  if (cached && cachedKey === key) return cached;

  cached = token
    ? new BlobStorage(url, token)
    : new MemoryStorage('UPSTASH_BLOB_TOKEN не задан — работает аварийный режим');
  cachedKey = key;
  return cached;
}