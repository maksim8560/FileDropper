/** Точечная проверка правил: гостевой срок, счётчик, аккаунты. */
const BASE = 'http://127.0.0.1:8788';

async function json(path, options = {}) {
  const res = await fetch(BASE + path, options);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function upload(ttl, headers = {}) {
  const fd = new FormData();
  fd.append('file', new File(['проверка правил'], 'rules.txt', { type: 'text/plain' }));
  fd.append('ttl', String(ttl));
  fd.append('ownerToken', 'rules-test');
  return json('/api/upload', { method: 'POST', body: fd, headers });
}

const out = [];

// 1. Гость просит 7 дней — должен получить 1 час
const anon = await upload(168);
const anonHours = (anon.body?.file?.expiresAt - Date.now()) / 3600000;
out.push(['гость: срок 1 час, хотя просил 7 дней', Math.abs(anonHours - 1) < 0.05, `${anonHours.toFixed(2)} ч`]);

// 2. Зарегистрированный выбирает 7 дней
const login = `rules_${Date.now().toString(36)}`;
const reg = await json('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: 'правила-длинный-пароль' }),
});
const authed = await upload(168, { authorization: `Bearer ${reg.body?.token}` });
const authedHours = authed.body?.file?.expiresAt ? (authed.body.file.expiresAt - Date.now()) / 3600000 : null;
out.push(['в аккаунте: срок 7 дней', Math.abs(authedHours - 168) < 0.5, `${authedHours?.toFixed(1)} ч`]);

// 3. Счётчик скачиваний
const id = anon.body?.file?.id;
await fetch(`${BASE}/api/file/${id}?dl=1`).then((r) => r.text());
let downloads = 0;
for (let i = 0; i < 12 && downloads < 1; i++) {
  downloads = (await json(`/api/file/${id}`)).body?.file?.downloads ?? 0;
  if (downloads < 1) await new Promise((r) => setTimeout(r, 400));
}
out.push(['счётчик скачиваний сохраняется', downloads === 1, String(downloads)]);

// 4. Гость не может получить доступ к гостю-файлу через кабинет
const meGuest = await json('/api/auth/me');
out.push(['гость: профиль недоступен', meGuest.status === 401, String(meGuest.status)]);

await json(`/api/file/${id}`, { method: 'DELETE', headers: { 'x-owner-token': 'rules-test' } });
await json('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${reg.body?.token}` } });

console.log('');
for (const [name, ok, detail] of out) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ok ? '' : '→ ' + detail}`);
const failed = out.filter(([, ok]) => !ok).length;
console.log(`\nПровалено: ${failed}`);
process.exit(failed ? 1 : 0);