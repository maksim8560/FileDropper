/** Проверка админ-панели и заметок (ASCII-пароль, чтобы PowerShell не портил аргументы). */
const B = 'http://127.0.0.1:8788';
const j = async (p, o = {}) => {
  const r = await fetch(B + p, o);
  return { s: r.status, b: await r.json().catch(() => null) };
};

const LOGIN = process.env.ADMIN_LOGIN || 'admintest2';
const PASS = process.env.ADMIN_PASSWORD || 'admintest2-pass-2026';

let r = await j('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: LOGIN, password: PASS }),
});
console.log('регистрация:', r.s, r.b?.token ? '(токен есть)' : JSON.stringify(r.b));

let token = r.b?.token;
if (!token) {
  r = await j('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASS }),
  });
  token = r.b?.token;
  console.log('вход:', r.s, token ? '(токен есть)' : JSON.stringify(r.b));
}
if (!token) process.exit(1);

const H = { authorization: 'Bearer ' + token };
const JH = { ...H, 'content-type': 'application/json' };

const me = await j('/api/auth/me', { headers: H });
console.log('isAdmin:', me.b?.user?.isAdmin, '| логин:', me.b?.user?.username);

const note = await j('/api/admin/notes', {
  method: 'POST',
  headers: JH,
  body: JSON.stringify({ title: 'Тестовая запись', text: 'Данные сайта хранятся в Blob' }),
});
console.log('создание заметки:', note.s, '| id:', note.b?.note?.id);

const list = await j('/api/admin/notes', { headers: H });
console.log('заметок:', list.b?.notes?.length, '| первая:', list.b?.notes?.[0]?.title);

const edit = await j(`/api/admin/notes/${note.b.note.id}`, {
  method: 'PUT',
  headers: JH,
  body: JSON.stringify({ title: 'Изменённая запись', text: 'новый текст' }),
});
console.log('изменение заметки:', edit.s, '|', edit.b?.note?.title);

const ov = await j('/api/admin/overview', { headers: H });
console.log('сводка:', ov.s, '| файлов:', ov.b?.counts?.files, '| юзеров:', ov.b?.counts?.users, '| записей:', ov.b?.counts?.notes);

const st = await j('/api/admin/settings', {
  method: 'PUT',
  headers: JH,
  body: JSON.stringify({ maxFileSizeMb: 500, anonymousTtlHours: 1, maxFilesPerUpload: 4 }),
});
console.log('настройки:', st.s, '| лимит:', st.b?.settings?.maxFileSizeMb, 'МБ | гостевой срок:', st.b?.settings?.anonymousTtlHours);

const guest = await j('/api/admin/overview');
console.log('админка без токена:', guest.s, '(ожидаем 401)');

const del = await j(`/api/admin/notes/${note.b.note.id}`, { method: 'DELETE', headers: H });
console.log('удаление заметки:', del.s);

const cleanup = await j('/api/admin/cleanup', { method: 'POST', headers: H });
console.log('чистка:', cleanup.s, '| удалено записей:', cleanup.b?.removed);

console.log('\nLOGIN=' + LOGIN);