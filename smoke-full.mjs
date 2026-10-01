/** Полный сценарий на живом API: аккаунт, файл, кабинет, удаление. */
const B = process.env.BASE || 'https://filedropper-api.sonora-online.workers.dev';

const j = async (p, o = {}) => {
  const r = await fetch(B + p, o);
  const t = await r.text();
  let b = null;
  try { b = JSON.parse(t); } catch { b = t.slice(0, 120); }
  return { s: r.status, b };
};
const ok = (n, c, d = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  → ' + d}`);

const login = `full-check-${Date.now().toString(36)}`;
const pass = 'parol-dlya-proverki-2026';

// 1. Регистрация
const reg = await j('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: pass }),
});
ok('регистрация', reg.s === 201 && !!reg.b?.token, `status=${reg.s} ${JSON.stringify(reg.b).slice(0, 90)}`);
const token = reg.b?.token;

// 2. Вход
const li = await j('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: pass }),
});
ok('вход с паролем', li.s === 200 && !!li.b?.token, `status=${li.s}`);

// 3. Неверный пароль
const bad = await j('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: 'nepravilnyy-parol' }),
});
ok('неверный пароль → 401', bad.s === 401, `status=${bad.s}`);

// 4. Профиль
const H = { authorization: `Bearer ${token}` };
const me = await j('/api/auth/me', { headers: H });
ok('профиль по токену', me.s === 200, `status=${me.s}`);
ok('обычный пользователь не админ', me.b?.user?.isAdmin === false, String(me.b?.user?.isAdmin));

// 5. Загрузка файла под аккаунтом (срок выбирает авторизованный)
const payload = new TextEncoder().encode('файл из аккаунта');
const sign = await j('/api/upload/sign', {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Отчёт.docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: payload.byteLength,
    ttl: 168,
    once: false,
    ownerToken: 'own-check',
  }),
});
ok('подпись на файл', sign.s === 201, `status=${sign.s} ${JSON.stringify(sign.b).slice(0, 80)}`);
const hours = sign.b?.file ? (sign.b.file.expiresAt - Date.now()) / 3600000 : null;
ok('в аккаунте срок 7 дней', hours !== null && Math.abs(hours - 168) < 0.5, `${hours?.toFixed(1)} ч`);
ok('файл привязан к аккаунту', sign.b?.userId === me.b?.user?.id, String(sign.b?.userId));

const putFile = await fetch(sign.b.payload.url, { method: 'PUT', headers: sign.b.payload.headers, body: payload });
ok('файл залит', putFile.status === 200, `status=${putFile.status}`);
const putMeta = await fetch(sign.b.meta.url, {
  method: 'PUT',
  headers: sign.b.meta.headers,
  body: new TextEncoder().encode(sign.b.metaBody),
});
ok('метаданные залиты', putMeta.status === 200, `status=${putMeta.status}`);

const commit = await j('/api/upload/complete', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ id: sign.b.file.id }) });
ok('загрузка зафиксирована', commit.s === 200, `status=${commit.s}`);

// 6. Файл появился в кабинете (индекс пишется фоновой задачей Worker'а)
let inCabinet = [];
for (let i = 0; i < 10; i++) {
  inCabinet = (await j('/api/me/files', { headers: H })).b?.files ?? [];
  if (inCabinet.some((f) => f.id === sign.b.file.id)) break;
  await new Promise((r) => setTimeout(r, 400));
}
ok('файл виден в кабинете', inCabinet.some((f) => f.id === sign.b.file.id), JSON.stringify(inCabinet.map((f) => f.id)));

// 7. Скачивание
const dl = await fetch(`${B}/api/file/${sign.b.file.id}?dl=1`);
ok('скачивание', dl.status === 200 && (await dl.text()) === 'файл из аккаунта', `status=${dl.status}`);

// 8. Счётчик скачиваний (обновляется фоновой записью Worker'а)
let downloads = 0;
for (let i = 0; i < 12 && downloads < 1; i++) {
  downloads = (await j(`/api/file/${sign.b.file.id}`)).b?.file?.downloads ?? 0;
  if (downloads < 1) await new Promise((r) => setTimeout(r, 400));
}
ok('счётчик скачиваний записан Worker\'ом', downloads === 1, String(downloads));

// 9. Одноразовая ссылка
const sign2 = await j('/api/upload/sign', {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'once.txt', type: 'text/plain', size: 4, ttl: 24, once: true, ownerToken: 'own-once' }),
});
await fetch(sign2.b.payload.url, { method: 'PUT', headers: sign2.b.payload.headers, body: new TextEncoder().encode('once') });
await fetch(sign2.b.meta.url, { method: 'PUT', headers: sign2.b.meta.headers, body: new TextEncoder().encode(sign2.b.metaBody) });
await j('/api/upload/complete', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ id: sign2.b.file.id }) });
const first = await fetch(`${B}/api/file/${sign2.b.file.id}?dl=1`);
await first.text();
const second = await fetch(`${B}/api/file/${sign2.b.file.id}?dl=1`);
ok('одноразовая: первая → 200', first.status === 200, `status=${first.status}`);
ok('одноразовая: вторая → 410', second.status === 410, `status=${second.status}`);

// 10. Удаление
const del = await j(`/api/file/${sign.b.file.id}`, { method: 'DELETE', headers: H });
ok('удаление своего файла по сессии', del.s === 200, `status=${del.s}`);

// 11. Админка: до выхода — 403, без токена — 401
const admin = await j('/api/admin/overview', { headers: H });
ok('админка недоступна обычному → 403', admin.s === 403, `status=${admin.s}`);
const adminAnon = await j('/api/admin/overview');
ok('админка без токена → 401', adminAnon.s === 401, `status=${adminAnon.s}`);

// 12. Выход
const out = await j('/api/auth/logout', { method: 'POST', headers: H });
ok('выход', out.s === 200, `status=${out.s}`);
const after = await j('/api/auth/me', { headers: H });
ok('токен мёртв после выхода', after.s === 401, `status=${after.s}`);

process.exit(0);