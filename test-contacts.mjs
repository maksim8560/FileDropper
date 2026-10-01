/**
 * Проверка контактов: добавление в панели, вывод на главной, удаление.
 * Локальный воркер, :8788.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
let failed = 0;
const check = (n, ok, d = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  → ' + d}`);
};
const api = async (p, o = {}) => {
  const r = await fetch(BASE + p, o);
  return { status: r.status, body: await r.json().catch(() => null) };
};

const pass = 'parol-dlya-proverki-2026';
await api('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: 'MaxDiWay', password: pass }),
});
const admin = await api('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: 'MaxDiWay', password: pass }),
});
check('вход админа', admin.status === 200, `status=${admin.status}`);
const H = { authorization: `Bearer ${admin.body.token}`, 'content-type': 'application/json' };

/* --- главная видна гостю --- */
const empty = await api('/api/stats');
check('контакты приезжают на главную', Array.isArray(empty.body?.contacts), JSON.stringify(empty.body?.contacts));

/* --- добавили ссылку и текст --- */
const link = await api('/api/admin/contacts', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: 'Телеграм', value: 't.me/example', kind: 'link' }),
});
check('добавлена ссылка', link.status === 201 && !!link.body?.contact?.id, `status=${link.status}`);
check('ссылка приведена к https', link.body?.contact?.value === 'https://t.me/example', link.body?.contact?.value);

const text = await api('/api/admin/contacts', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: 'Почта', value: 'help@example.ru', kind: 'text' }),
});
check('добавлен текст', text.status === 201, `status=${text.status}`);

/* --- порядок сохраняется --- */
const list = await api('/api/admin/contacts', { headers: { authorization: `Bearer ${admin.body.token}` } });
check('в списке два контакта', list.body?.contacts?.length === 2, JSON.stringify(list.body?.contacts?.map((c) => c.title)));
check('порядок как добавлены', list.body?.contacts?.[0]?.title === 'Телеграм', JSON.stringify(list.body?.contacts?.map((c) => c.title)));

/* --- видно гостю без входа --- */
const guest = await api('/api/stats');
check('гость видит оба контакта', guest.body?.contacts?.length === 2, JSON.stringify(guest.body?.contacts?.map((c) => c.title)));
check('служебных полей нет', guest.body?.contacts?.every((c) => !('createdAt' in c)), 'в гостевом ответе только id/title/value/kind');

/* --- мусор не принимаем --- */
const noValue = await api('/api/admin/contacts', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Пусто', value: '' }) });
check('без значения → 400', noValue.status === 400, `status=${noValue.status}`);

const bad = await api('/api/admin/contacts', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: 'Опасная', value: 'javascript:alert(1)', kind: 'link' }),
});
check('опасная схема отклонена', bad.status === 400, `status=${bad.status}`);

/* --- гостю и чужому нельзя --- */
const guestAdd = await fetch(BASE + '/api/admin/contacts', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Хак', value: 'x', kind: 'text' }),
});
check('без входа добавить нельзя → 401', guestAdd.status === 401, `status=${guestAdd.status}`);

const reg = await api('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: `c-${Date.now().toString(36)}`, password: pass }),
});
const otherList = await api('/api/admin/contacts', { headers: { authorization: `Bearer ${reg.body.token}` } });
check('чужой список контактов → 403', otherList.status === 403, `status=${otherList.status}`);

/* --- удаление --- */
const del = await api(`/api/admin/contacts/${link.body.contact.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${admin.body.token}` } });
check('удаление работает', del.status === 200, `status=${del.status}`);

const after = await api('/api/stats');
check('удалённого на главной нет', after.body?.contacts?.every((c) => c.id !== link.body.contact.id), JSON.stringify(after.body?.contacts));

const delAgain = await api(`/api/admin/contacts/${link.body.contact.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${admin.body.token}` } });
check('повторное удаление → 404', delAgain.status === 404, `status=${delAgain.status}`);

/* --- убираем оставшийся тестовый контакт --- */
if (text.body?.contact?.id) {
  await api(`/api/admin/contacts/${text.body.contact.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${admin.body.token}` } });
}

console.log(failed ? `\nпровалено: ${failed}` : '\nвсе проверки пройдены');
process.exit(failed ? 1 : 0);