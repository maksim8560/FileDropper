/**
 * Слой «небольших» данных: аккаунты, сессии, настройки сайта, индексы файлов.
 *
 * Всё лежит в том же Upstash Blob, что и файлы, но через отдельный аккуратный
 * интерфейс (get/put/del/list), чтобы не тащить с собой ещё одну базу.
 * Если секрет хранилища не задан, тот же интерфейс закрывает аварийный
 * провайдер в памяти воркера — сайт продолжает работать.
 */

import { createStorage } from './storage.js';

export class KvError extends Error {
  constructor(message, { status = 502, code = 'kv_error' } = {}) {
    super(message);
    this.name = 'KvError';
    this.status = status;
    this.code = code;
  }
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Аккаунты и настройки — те же блобы, только с JSON-полезной нагрузкой. */
class BlobKv {
  constructor(storage) {
    this.storage = storage;
    this.provider = 'upstash-blob';
  }

  get degraded() {
    return this.storage.degraded;
  }

  status() {
    return { ...this.storage.status(), provider: this.provider };
  }

  async get(key) {
    const data = await this.storage.get(key);
    if (!data) return null;
    try {
      return JSON.parse(await new Response(data.body).text());
    } catch {
      return null;
    }
  }

  async put(key, value) {
    const raw = JSON.stringify(value);
    await this.storage.put(key, raw, { contentType: JSON_TYPE, size: new TextEncoder().encode(raw).length });
    return true;
  }

  async del(key) {
    await this.storage.del(key);
    return true;
  }

  async list(prefix = '', limit = 200) {
    const { blobs } = await this.storage.list(prefix, limit);
    return { keys: blobs.map((b) => b.pathname || b.path).filter(Boolean) };
  }

  async count(prefix = '', limit = 500) {
    const { keys } = await this.list(prefix, limit);
    return keys.length;
  }

  async ping() {
    return this.storage.ping();
  }
}

/* ---------------- аварийный режим: память изолята ---------------- */

class MemoryKv {
  constructor(storage) {
    this.storage = storage;
    this.provider = 'memory-kv';
    this.map = storage.map; // тот же кэш, что и у файлов в аварийном режиме
  }

  get degraded() {
    return true;
  }

  status() {
    return { provider: this.provider, degraded: true, authState: 'memory', lastError: this.storage.lastError };
  }

  async get(key) {
    return this.map.has(key) ? structuredClone(this.map.get(key)) : null;
  }

  async put(key, value) {
    this.map.set(key, structuredClone(value));
    return true;
  }

  async del(key) {
    this.map.delete(key);
    return true;
  }

  async list(prefix = '', limit = 200) {
    const keys = [];
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) keys.push(key);
      if (keys.length >= limit) break;
    }
    return { keys };
  }

  async count(prefix = '') {
    let total = 0;
    for (const key of this.map.keys()) if (key.startsWith(prefix)) total += 1;
    return total;
  }

  async ping() {
    return { ok: false, error: 'Данные в памяти воркера', code: 'memory_mode' };
  }
}

/* ------------------------------------------------------------------ */

export function createKv(env = {}) {
  // В аварийном режиме файлы уже лежат в памяти — используем тот же кэш,
  // чтобы аккаунты и файлы вели себя одинаково.
  const storage = createStorage(env);
  return storage.degraded ? new MemoryKv(storage) : new BlobKv(storage);
}