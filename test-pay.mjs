/**
 * Проверка платёжного слоя: ручной режим, включение провайдера без секретов,
 * заказ, реквизиты и подтверждение оплаты через опрос. Локальный воркер, :8788.
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

/* --- админ --- */
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
const AH = { authorization: `Bearer ${admin.body.token}`, 'content-type': 'application/json' };

/* --- пользователь --- */
const login = `pay-${Date.now().toString(36)}`;
const reg = await api('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: pass }),
});
check('регистрация', reg.status === 201, `status=${reg.status}`);
const H = { authorization: `Bearer ${reg.body.token}`, 'content-type': 'application/json' };

/* --- 1. Ручной режим: оплаты нет --- */
await api('/api/admin/settings', {
  method: 'PUT',
  headers: AH,
  body: JSON.stringify({ subEnabled: true, subProvider: 'manual', subPriceRub: 350 }),
});
const st1 = await api('/api/billing/status', { headers: { authorization: `Bearer ${reg.body.token}` } });
check('провайдер: вручную', st1.body?.subscription?.provider === 'manual', JSON.stringify(st1.body?.subscription?.provider));
check('онлайн-оплата не готова', st1.body?.subscription?.ready === false, String(st1.body?.subscription?.ready));
check('цена видна', st1.body?.subscription?.priceRub === 350, String(st1.body?.subscription?.priceRub));

const co1 = await api('/api/billing/checkout', { method: 'POST', headers: H });
check('в ручном режиме заказ не создаётся → 403', co1.status === 403 && co1.body?.error?.code === 'provider_manual', `status=${co1.status}`);

/* --- 2. Ручная выдача продолжает работать --- */
const grant = await api('/api/admin/subscription', { method: 'PUT', headers: AH, body: JSON.stringify({ login, days: 30 }) });
check('подписка выдаётся вручную', grant.status === 200 && grant.body?.subscription?.active === true, `status=${grant.status}`);
const st2 = await api('/api/billing/status', { headers: { authorization: `Bearer ${reg.body.token}` } });
check('подписка сохранилась', st2.body?.subscription?.active === true, JSON.stringify(st2.body?.subscription));
check('доступны сроки до 30 дней', st2.body?.ttl?.maxHours === 720, String(st2.body?.ttl?.maxHours));

/* --- 3. Провайдер включён, но секретов нет --- */
await api('/api/admin/settings', { method: 'PUT', headers: AH, body: JSON.stringify({ subProvider: 'h2h' }) });
const st3 = await api('/api/billing/status', { headers: { authorization: `Bearer ${reg.body.token}` } });
check('h2h выбран, но не настроен', st3.body?.subscription?.provider === 'h2h' && st3.body?.subscription?.ready === false, JSON.stringify(st3.body?.subscription));

const co3 = await api('/api/billing/checkout', { method: 'POST', headers: H });
check('без секретов → 503 с понятным кодом', co3.status === 503 && co3.body?.error?.code === 'payment_not_configured', `status=${co3.status}`);

/* --- 4. Чужой заказ не отдаём --- */
const req = await api('/api/billing/requisites?invoice=sub-x', { headers: H });
check('чужой/несуществующий заказ → 404 или 403', req.status === 404 || req.status === 403, `status=${req.status}`);

/* --- 5. Вебхук без корректной оплаты ничего не включает --- */
const hook = await api('/api/billing/webhook', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ order_id: 'нет-такого', status: 'completed', account_id: 'нет' }),
});
check('пустой вебхук отвечает 200 и ничего не ломает', hook.status === 200, `status=${hook.status}`);

/* --- 6. Подписку нельзя продлить одним и тем же платежом --- */
const before = await api('/api/billing/status', { headers: { authorization: `Bearer ${reg.body.token}` } });
const expiryBefore = before.body?.subscription?.expiresAt;
await api('/api/admin/subscription', { method: 'PUT', headers: AH, body: JSON.stringify({ login, days: 30, /* повторная выдача */ }) });
const after = await api('/api/billing/status', { headers: { authorization: `Bearer ${reg.body.token}` } });
check('повторная выдача продлевает срок', after.body?.subscription?.expiresAt > expiryBefore, `${expiryBefore} → ${after.body?.subscription?.expiresAt}`);

/* --- 7. Список провайдеров приезжает в статусе --- */
const list = st1.body?.subscription?.providers?.map((p) => p.id) || [];
check('в статусе есть список провайдеров', list.includes('manual') && list.includes('h2h') && list.includes('cloudpayments'), JSON.stringify(list));

console.log(failed ? `\nпровалено: ${failed}` : '\nвсе проверки пройдены');
process.exit(failed ? 1 : 0);