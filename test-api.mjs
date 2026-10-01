/**
 * e2e-проверка API Файлообменника (wrangler dev на :8788).
 * Запуск: node test-api.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
}

async function json(path, options) {
  const res = await fetch(BASE + path, options);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, res };
}

const content = 'Привет, Файлообменник! Это тестовое содержимое.\n'.repeat(40);

// --- 1. Загрузка ---
const fd = new FormData();
fd.append('file', new File([content], 'Тест Файл.txt', { type: 'text/plain' }));
fd.append('ttl', '1');
fd.append('once', '0');
fd.append('ownerToken', 'owner-token-test-123');

const up = await json('/api/upload', { method: 'POST', body: fd });
const id = up.body?.file?.id;
check('загрузка файла → 201', up.status === 201, `status=${up.status} body=${JSON.stringify(up.body)}`);
check('имя файла с кириллицей сохранено', up.body?.file?.name === 'Тест Файл.txt', up.body?.file?.name);
check('размер совпадает', up.body?.file?.size === new Blob([content]).size, `${up.body?.file?.size}`);
check('срок 1 час установлен', Math.abs(up.body?.file?.expiresAt - (Date.now() + 3600e3)) < 5000, String(up.body?.file?.expiresAt));
check('ключ в Blob — ASCII (транслитерация)', /^f\/[a-z0-9]+\/[a-z0-9\-._]+$/.test(id ? `f/${id}/test-file.txt` : ''), 'см. meta');
check('ссылки в ответе', up.body?.links?.download === `/api/file/${id}?dl=1`, JSON.stringify(up.body?.links));

// --- 2. Метаданные ---
const meta = await json(`/api/file/${id}`);
check('метаданные по GET → 200', meta.status === 200, `status=${meta.status}`);
check('скачиваний пока 0', meta.body?.file?.downloads === 0, String(meta.body?.file?.downloads));

// --- 3. Скачивание ---
const dl = await fetch(`${BASE}/api/file/${id}?dl=1`);
const dlText = await dl.text();
check('скачивание → 200', dl.status === 200, `status=${dl.status}`);
check('тело файла целое', dlText === content, `${dlText.length} симв.`);
check('Content-Disposition: attachment', (dl.headers.get('content-disposition') || '').startsWith('attachment'), dl.headers.get('content-disposition'));
check('RFC 5987 имя в заголовке', (dl.headers.get('content-disposition') || '').includes("filename*=UTF-8''"), dl.headers.get('content-disposition'));
check('content-type из файла', (dl.headers.get('content-type') || '').includes('text/plain'), dl.headers.get('content-type'));
check('nosniff', dl.headers.get('x-content-type-options') === 'nosniff', dl.headers.get('x-content-type-options'));
check('CORS-заголовок присутствует', dl.headers.get('access-control-allow-origin') === '*', dl.headers.get('access-control-allow-origin'));

// --- 4. Счётчик (обновляется в фоне, поэтому ждём до 3 секунд) ---
let downloads = 0;
for (let i = 0; i < 15 && downloads < 1; i++) {
  downloads = (await json(`/api/file/${id}`)).body?.file?.downloads ?? 0;
  if (downloads < 1) await new Promise((r) => setTimeout(r, 200));
}
check('счётчик скачиваний вырос', downloads === 1, String(downloads));

// --- 5. Range ---
const range = await fetch(`${BASE}/api/file/${id}?dl=1`, { headers: { Range: 'bytes=0-9' } });
const rangeText = await range.text();
check('Range → 206', range.status === 206, `status=${range.status}`);
check('Content-Range корректен', /bytes 0-9\/\d+/.test(range.headers.get('content-range') || ''), range.headers.get('content-range'));
check('Range вернул 10 байт', new TextEncoder().encode(rangeText).length === 10, `${new TextEncoder().encode(rangeText).length} байт`);

// --- 6. Превью ---
const raw = await fetch(`${BASE}/api/raw/${id}`);
check('превью доступно', raw.status === 200, `status=${raw.status}`);
check('превью inline', (raw.headers.get('content-disposition') || '').startsWith('inline'), raw.headers.get('content-disposition'));

// --- 7. Защита удаления ---
const wrong = await json(`/api/file/${id}`, { method: 'DELETE', headers: { 'x-owner-token': 'wrong' } });
check('удаление с чужим токеном → 403', wrong.status === 403, `status=${wrong.status}`);

// --- 8. Одноразовая ссылка ---
const fdOnce = new FormData();
fdOnce.append('file', new File(['одноразовый'], 'once.txt', { type: 'text/plain' }));
fdOnce.append('once', '1');
fdOnce.append('ttl', '24');
fdOnce.append('ownerToken', 'owner-once');
const upOnce = await json('/api/upload', { method: 'POST', body: fdOnce });
const onceId = upOnce.body?.file?.id;
check('одноразовая отмечена в метаданных', upOnce.body?.file?.once === true, String(upOnce.body?.file?.once));
const firstDl = await fetch(`${BASE}/api/file/${onceId}?dl=1`);
check('первое скачивание одноразовой → 200', firstDl.status === 200, `status=${firstDl.status}`);
await firstDl.text();
await new Promise((r) => setTimeout(r, 250));
const secondDl = await fetch(`${BASE}/api/file/${onceId}?dl=1`);
check('второе скачивание одноразовой → 410', secondDl.status === 410, `status=${secondDl.status}`);
const goneMeta = await json(`/api/file/${onceId}`);
check('одноразовый файл удалён, но метка живёт (410)', goneMeta.status === 410, `status=${goneMeta.status}`);

// --- 9. Удаление ---
const del = await json(`/api/file/${id}`, { method: 'DELETE', headers: { 'x-owner-token': 'owner-token-test-123' } });
check('удаление с верным токеном → 200', del.status === 200, `status=${del.status}`);
const afterDel = await json(`/api/file/${id}`);
check('после удаления файл не найден', afterDel.status === 404, `status=${afterDel.status}`);

// --- 10. Ошибки ---
check('несуществующий id → 404', (await json('/api/file/zzzzzzzz')).status === 404);
check('неизвестный метод API → 404', (await json('/api/nope')).status === 404);
check('GET на /api/upload → 405', (await json('/api/upload')).status === 405);
const emptyFd = new FormData();
emptyFd.append('file', new File([], 'empty.txt', { type: 'text/plain' }));
check('пустой файл → 400', (await json('/api/upload', { method: 'POST', body: emptyFd })).status === 400);
const noFile = new FormData();
noFile.append('ttl', '1');
check('запрос без файла → 400', (await json('/api/upload', { method: 'POST', body: noFile })).status === 400);
const badId = await json('/api/file/AB!C');
check('некорректный id → 404 (regex-фильтр)', badId.status === 404, `status=${badId.status}`);

// --- 11. OPTIONS ---
const pre = await fetch(`${BASE}/api/upload`, {
  method: 'OPTIONS',
  headers: { Origin: 'https://maksim8560.github.io', 'Access-Control-Request-Method': 'POST' },
});
check('preflight → 204', pre.status === 204, `status=${pre.status}`);
check('preflight CORS-методы', (pre.headers.get('access-control-allow-methods') || '').includes('POST'), pre.headers.get('access-control-allow-methods'));
check('preflight CORS-заголовки', (pre.headers.get('access-control-allow-headers') || '').includes('x-owner-token'), pre.headers.get('access-control-allow-headers'));

// --- 12. Статика ---
const page = await fetch(`${BASE}/`);
const html = await page.text();
check('главная отдаётся', page.status === 200 && html.includes('Файлообменник'), `status=${page.status}`);
check('CSP задан', (page.headers.get('content-security-policy') || '').includes("default-src 'self'"), page.headers.get('content-security-policy')?.slice(0, 60));
const spa = await fetch(`${BASE}/f/${id}`);
check('SPA-fallback на /f/<id>', spa.status === 200, `status=${spa.status}`);

// --- 12. Авторизация ---
const login = `user_${Date.now().toString(36)}`;
const pass = 'очень-длинный-пароль-123';

const badReg = await json('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: 'ab', password: pass }),
});
check('регистрация: короткий логин → 400', badReg.status === 400, `status=${badReg.status}`);

const badPass = await json('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: 'коротк' }),
});
check('регистрация: короткий пароль → 400', badPass.status === 400, `status=${badPass.status}`);

const reg = await json('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: pass }),
});
check('регистрация → 201 и токен', reg.status === 201 && !!reg.body?.token, `status=${reg.status}`);
const token = reg.body?.token;

const dup = await json('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: pass }),
});
check('повторная регистрация логина → 409', dup.status === 409, `status=${dup.status}`);

const wrongPass = await json('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: 'неправильный' }),
});
check('вход с неверным паролем → 401', wrongPass.status === 401, `status=${wrongPass.status}`);

const noUser = await json('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: 'nobody-here-xyz', password: pass }),
});
check('вход несуществующего → 401', noUser.status === 401, `status=${noUser.status}`);

const relogin = await json('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: pass }),
});
check('вход с верным паролем → токен', relogin.status === 200 && !!relogin.body?.token, `status=${relogin.status}`);

const meAnon = await json('/api/auth/me');
check('профиль без токена → 401', meAnon.status === 401, `status=${meAnon.status}`);

const meBad = await json('/api/auth/me', { headers: { authorization: 'Bearer definitely-not-a-real-token' } });
check('профиль с чужим токеном → 401', meBad.status === 401, `status=${meBad.status}`);

const me = await json('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
check('профиль по токену → 200', me.status === 200, `status=${me.status}`);
check('логин в профиле верный', me.body?.user?.username === login, me.body?.user?.username);
check('обычный пользователь не админ', me.body?.user?.isAdmin === false, String(me.body?.user?.isAdmin));

// --- 13. Файлы в кабинете ---
const fdUser = new FormData();
fdUser.append('file', new File(['файл из аккаунта'], 'личный.txt', { type: 'text/plain' }));
fdUser.append('ttl', '24');
fdUser.append('ownerToken', 'owner-user-test');
const upUser = await json('/api/upload', {
  method: 'POST',
  body: fdUser,
  headers: { authorization: `Bearer ${token}` },
});
const userFileId = upUser.body?.file?.id;
check('загрузка с токеном → файл принадлежит аккаунту', upUser.body?.file?.id && upUser.body?.userId, JSON.stringify(upUser.body?.userId));

const myFiles = await json('/api/me/files', { headers: { authorization: `Bearer ${token}` } });
check('в кабинете виден свой файл', myFiles.body?.files?.some((f) => f.id === userFileId), JSON.stringify(myFiles.body?.files?.map((f) => f.id)));

const delOwn = await json(`/api/file/${userFileId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
check('удаление своего файла по сессии → 200', delOwn.status === 200, `status=${delOwn.status}`);

// --- 14. Панель управления ---
const adminAnon = await json('/api/admin/overview');
check('админка без токена → 401', adminAnon.status === 401, `status=${adminAnon.status}`);

const adminUser = await json('/api/admin/overview', { headers: { authorization: `Bearer ${token}` } });
check('админка обычному пользователю → 403', adminUser.status === 403, `status=${adminUser.status}`);

const adminLogin = process.env.ADMIN_LOGIN || 'MaxDiWay';
const adminPass = process.env.ADMIN_PASSWORD || 'test-admin-password-2024';
let adminToken = null;
try {
  const ar = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: adminLogin, password: adminPass }),
  });
  if (ar.status === 200 && ar.body?.token) {
    adminToken = ar.body.token;
    const adm = await json('/api/auth/me', { headers: { authorization: `Bearer ${adminToken}` } });
    check('админ видит признак isAdmin', adm.body?.user?.isAdmin === true, String(adm.body?.user?.isAdmin));

    const overview = await json('/api/admin/overview', { headers: { authorization: `Bearer ${adminToken}` } });
    check('сводка админки отдаётся', overview.status === 200 && Array.isArray(overview.body?.recent), `status=${overview.status}`);

    const set = await json('/api/admin/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ maxFilesPerUpload: 7, heroLede: 'Проверка настроек админа' }),
    });
    check('настройки сохраняются', set.status === 200 && set.body?.settings?.maxFilesPerUpload === 7, `status=${set.status}`);

    const statsAfter = await json('/api/stats');
    check('новые лимиты применились в /api/stats', statsAfter.body?.maxFiles === 7, String(statsAfter.body?.maxFiles));

    // возвращаем как было
    await json('/api/admin/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ maxFilesPerUpload: 4, heroLede: 'Перетащи файл — получишь ссылку. Кто угодно откроет её и скачает файл.' }),
    });

    const cleanupRes = await json('/api/admin/cleanup', { method: 'POST', headers: { authorization: `Bearer ${adminToken}` } });
    check('ручная чистка отработала', cleanupRes.status === 200, `status=${cleanupRes.status}`);
  } else {
    console.log(`\n(админ-тесты пропущены: нет пароля для «${adminLogin}». Задайте ADMIN_PASSWORD, чтобы проверить)`);
  }
} catch (e) {
  console.log(`\n(админ-тесты пропущены: ${e.message})`);
}

// --- 15. Выход ---
const logout = await json('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
check('выход → 200', logout.status === 200, `status=${logout.status}`);
const afterLogout = await json('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
check('токен после выхода не работает → 401', afterLogout.status === 401, `status=${afterLogout.status}`);

// --- Итог ---
console.log('');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  → ${r.detail}`}`);
}
console.log(`\nВсего: ${results.length}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);