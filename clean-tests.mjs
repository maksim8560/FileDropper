/**
 * Точечная уборка тестовых записей: сначала показывает, что будет удалено,
 * и только если передан --yes. Ничего не трогает без явного подтверждения.
 *
 * Тестовые объекты опознаются по логину /^full-check-/ (их создаёт smoke-full.mjs)
 * и по принадлежности к уже удалённым тестовым пользователям.
 */
import { readFileSync } from 'node:fs';
import { createStorage } from './src/storage.js';

const vars = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')];
    }),
);

const storage = createStorage({
  UPSTASH_BLOB_URL: vars.UPSTASH_BLOB_URL,
  UPSTASH_BLOB_TOKEN: vars.UPSTASH_BLOB_TOKEN,
});

const TEST_USER = /^(full-check-|reload-test-|browser-reg-|prodcheck$|write-test$|admintest)/;
const yes = process.argv.includes('--yes');
const doomed = new Map(); // ключ → причина

/** get() отдаёт поток, поэтому читаем и разбираем сами. */
async function readJson(key) {
  const res = await storage.get(key);
  if (!res) return null;
  try {
    return JSON.parse(await new Response(res.body).text());
  } catch {
    return null;
  }
}

// 1. Пользователи
const users = await storage.list('user/', 200);
const testUserIds = new Set();
for (const item of users.blobs) {
  const key = item.pathname || item.path;
  const rec = await readJson(key);
  if (rec && TEST_USER.test(rec.username || '')) {
    doomed.set(key, `тестовый логин ${rec.username}`);
    testUserIds.add(rec.id);
  }
}

// 2. Сессии и индексы файлов тестовых пользователей
for (const prefix of ['session/', 'userfiles/']) {
  const list = await storage.list(prefix, 500);
  for (const item of list.blobs) {
    const key = item.pathname || item.path;
    const rec = await readJson(key);
    const owner = rec && (rec.userId || rec.user?.id);
    const isTest = rec && typeof rec.username === 'string' && TEST_USER.test(rec.username);
    if (owner && testUserIds.has(owner)) doomed.set(key, 'принадлежит тестовому пользователю');
    else if (isTest) doomed.set(key, 'тестовый логин');

    // Индекс файлов, у которых не осталось метаданных: осиротевший.
    if (prefix === 'userfiles/' && Array.isArray(rec)) {
      const alive = [];
      for (const file of rec) {
        const meta = await readJson(`m/${file.id}.json`);
        if (meta) alive.push(file.id);
      }
      if (!alive.length && rec.length) doomed.set(key, 'индекс без файлов (осиротевший)');
    }
  }
}

// 3. Файлы и метаданные тестовых пользователей
for (const prefix of ['m/', 'f/']) {
  const list = await storage.list(prefix, 500);
  for (const item of list.blobs) {
    const key = item.pathname || item.path;
    const rec = await readJson(key);
    const owner = rec && (rec.userId || rec.userId);
    if (owner && testUserIds.has(owner)) doomed.set(key, 'файл тестового пользователя');
    else if (rec && typeof rec.name === 'string' && /^(Отчёт\.docx|once\.txt)$/.test(rec.name)) {
      doomed.set(key, `тестовый файл ${rec.name}`);
    }
  }
}

console.log(`найдено к удалению: ${doomed.size}`);
for (const [key, why] of doomed) console.log(`  ${key}  —  ${why}`);

if (!doomed.size) {
  console.log('удалять нечего');
} else if (!yes) {
  console.log('это только предпросмотр. Повторите с --yes, чтобы удалить.');
} else {
  let done = 0;
  for (const key of doomed.keys()) {
    await storage.del(key).catch(() => {});
    done += 1;
  }
  console.log(`удалено: ${done}`);
}