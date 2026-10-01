/** Разведка: что сейчас лежит в бакете (только чтение). */
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

for (const prefix of ['user/', 'session/', 'm/', 'f/', 'userfiles/', 'notes/', 'settings/']) {
  const { blobs } = await storage.list(prefix, 100);
  console.log(`${prefix.padEnd(12)} ключей: ${blobs.length}`);
  for (const b of blobs.slice(0, 6)) {
    const key = b.pathname || b.path;
    const res = await storage.get(key);
    let brief = '(не читается)';
    try {
      brief = JSON.stringify(JSON.parse(await new Response(res.body).text())).slice(0, 120);
    } catch {
      /* оставляем как есть */
    }
    console.log(`   ${key} → ${brief}`);
  }
}