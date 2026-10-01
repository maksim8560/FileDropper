/**
 * Проверка шага «создать ссылку»: срок + одноразовость задаются после загрузки,
 * ссылка появляется вместе с выбором.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}`);
};

async function api(path, options = {}) {
  const res = await fetch(BASE + path, options);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const login = `link-${Date.now().toString(36)}`;
const pass = 'parol-dlya-proverki-2026';

// --- Вошедший: срок выбирает сам ---
const reg = await api('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: pass }),
});
check('регистрация', reg.status === 201, `status=${reg.status}`);
const H = { authorization: `Bearer ${reg.body.token}`, 'content-type': 'application/json' };

const text = 'проверка ссылки после загрузки';
const fd = new FormData();
fd.append('file', new File([text], 'Проверка ссылки.txt', { type: 'text/plain' }));
fd.append('pendingTtl', '1');
fd.append('ownerToken', 'own-link-test');
const up = await api('/api/upload', { method: 'POST', headers: { authorization: `Bearer ${reg.body.token}` }, body: fd });
check('загрузка', up.status === 201, `status=${up.status}`);
check('ссылки ещё нет: срок не выбран', up.body?.file?.ttlPending === true, JSON.stringify(up.body?.file));
const id = up.body.file.id;

// Пробуем создать ссылку без срока
const noTtl = await api(`/api/file/${id}/link`, { method: 'POST', headers: H, body: JSON.stringify({ once: false }) });
check('без срока ссылка не создаётся → 400', noTtl.status === 400, `status=${noTtl.status}`);

// Срок не из диапазона
const bad = await api(`/api/file/${id}/link`, { method: 'POST', headers: H, body: JSON.stringify({ hours: 0, once: false }) });
check('срок вне диапазона → 400', bad.status === 400, `status=${bad.status}`);

// Без подписки дольше бесплатного срока нельзя
const tooLong = await api(`/api/file/${id}/link`, { method: 'POST', headers: H, body: JSON.stringify({ hours: 168, once: false }) });
check('7 дней без подписки → 403', tooLong.status === 403 && tooLong.body?.error?.code === 'subscription_required', `status=${tooLong.status}`);

// Создаём: бесплатные сутки + одноразовая
const created = await api(`/api/file/${id}/link`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ hours: 24, once: true }),
});
check('ссылка создана', created.status === 200, `status=${created.status} ${JSON.stringify(created.body).slice(0, 100)}`);
check('одноразовая включена', created.body?.file?.once === true, JSON.stringify(created.body?.file));
const hours = (created.body.file.expiresAt - Date.now()) / 3600000;
check('срок 24 часа', Math.abs(hours - 24) < 0.5, `${hours.toFixed(1)} ч`);
check('ссылка вернулась', created.body?.links?.page === `/f/${id}`, JSON.stringify(created.body?.links));

// Без подписки срок не увеличить
const again = await api(`/api/file/${id}/link`, { method: 'POST', headers: H, body: JSON.stringify({ hours: 168, once: true }) });
check('без подписки срок не увеличить → 403', again.status === 403, `status=${again.status}`);

// Одноразовая: первая скачка работает, вторая нет
const first = await fetch(`${BASE}/api/file/${id}?dl=1`);
const firstBody = await first.text();
check('первое скачивание', first.status === 200 && firstBody === text, `status=${first.status}`);
const second = await fetch(`${BASE}/api/file/${id}?dl=1`);
check('второе скачивание отклонено → 410', second.status === 410, `status=${second.status}`);

// После использования одноразовую не отключить
const off = await api(`/api/file/${id}/link`, { method: 'POST', headers: H, body: JSON.stringify({ once: false }) });
check('после скачивания ссылка не меняется → 409', off.status === 409, `status=${off.status}`);

// --- Гость: срок назначает сервер, одноразовую выбрать можно ---
const guestToken = 'own-guest-' + Date.now().toString(36);
const fd2 = new FormData();
fd2.append('file', new File(['гостевой файл'], 'Гость.txt', { type: 'text/plain' }));
fd2.append('ttl', '99');
fd2.append('ownerToken', guestToken);
const up2 = await api('/api/upload', { method: 'POST', body: fd2 });
check('гость загрузил', up2.status === 201, `status=${up2.status}`);
const gid = up2.body.file.id;
const guestHours = (up2.body.file.expiresAt - Date.now()) / 3600000;
check('гостю ровно 1 час, что бы ни просил', Math.abs(guestHours - 1) < 0.1, `${guestHours.toFixed(2)} ч`);
check('гость не выбирает срок', up2.body.file.ttlPending === false, String(up2.body.file.ttlPending));

const guestNo = await api(`/api/file/${gid}/link`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-token': 'wrong-token' }, body: JSON.stringify({ once: true }) });
check('чужой токен не управляет ссылкой → 403', guestNo.status === 403, `status=${guestNo.status}`);

const guestLink = await api(`/api/file/${gid}/link`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-owner-token': guestToken },
  body: JSON.stringify({ once: true, hours: 168 }),
});
check('гость создаёт одноразовую ссылку', guestLink.status === 200 && guestLink.body.file.once === true, `status=${guestLink.status}`);
check('гостю срок не меняется', Math.abs((guestLink.body.file.expiresAt - Date.now()) / 3600000 - 1) < 0.1, 'срок остался 1 час');

const guestDl = await fetch(`${BASE}/api/file/${gid}?dl=1`);
await guestDl.text();
check('гостевая ссылка одноразовая', (await fetch(`${BASE}/api/file/${gid}?dl=1`)).status === 410, 'второе скачивание отклонено');

// Уборка
await api(`/api/file/${gid}`, { method: 'DELETE', headers: { 'x-owner-token': guestToken } });

console.log(failed ? `\nпровалено: ${failed}` : '\nвсе проверки пройдены');
process.exit(failed ? 1 : 0);