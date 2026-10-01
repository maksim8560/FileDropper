/**
 * Проверка подписки: сроки зависят от оплаты, потеря подписки срезает срок,
 * повторная оплата возвращает выбранные сроки. Локальный воркер, :8788.
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

const login = `sub-${Date.now().toString(36)}`;
const pass = 'parol-dlya-proverki-2026';

const reg = await api('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: pass }),
});
check('регистрация', reg.status === 201, `status=${reg.status}`);
const H = { authorization: `Bearer ${reg.body.token}`, 'content-type': 'application/json' };

/* --- без подписки --- */
let state = await api('/api/billing/status', { headers: { authorization: `Bearer ${reg.body.token}` } });
check('статус подписки отдаётся', state.status === 200, `status=${state.status}`);
check('подписки нет', state.body?.subscription?.active === false, JSON.stringify(state.body?.subscription));
check('без подписки срок фиксирован', state.body?.ttl?.selectable === false && state.body?.ttl?.maxHours === 24, JSON.stringify(state.body?.ttl));

/* --- загрузка и создание ссылки без подписки --- */
const fd = new FormData();
fd.append('file', new File(['подписка'], 'Подписка.txt', { type: 'text/plain' }));
fd.append('pendingTtl', '1');
const up = await api('/api/upload', { method: 'POST', headers: { authorization: `Bearer ${reg.body.token}` }, body: fd });
check('загрузка', up.status === 201, `status=${up.status}`);
const id = up.body.file.id;

const tooMuch = await api(`/api/file/${id}/link`, { method: 'POST', headers: H, body: JSON.stringify({ hours: 720 }) });
check('30 дней без подписки → 403', tooMuch.status === 403 && tooMuch.body?.error?.code === 'subscription_required', `status=${tooMuch.status} ${JSON.stringify(tooMuch.body).slice(0, 80)}`);

const ok24 = await api(`/api/file/${id}/link`, { method: 'POST', headers: H, body: JSON.stringify({ hours: 24 }) });
check('сутки без подписки можно', ok24.status === 200, `status=${ok24.status}`);
check('срок примерно сутки', Math.abs((ok24.body.file.expiresAt - Date.now()) / 3600000 - 24) < 0.2, 'проверка срока');

/* --- выдаём подписку админом (эмулируем оплату) --- */
const adminLogin = 'MaxDiWay';
const adminReg = await api('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: adminLogin, password: pass }),
});
check('регистрация админа', adminReg.status === 201 || adminReg.status === 409, `status=${adminReg.status}`);
const adminAuth = await api('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: adminLogin, password: pass }),
});
check('вход админа', adminAuth.status === 200, `status=${adminAuth.status}`);
const AH = { authorization: `Bearer ${adminAuth.body.token}`, 'content-type': 'application/json' };

// Настройки подписки
const setSub = await api('/api/admin/settings', {
  method: 'PUT',
  headers: AH,
  body: JSON.stringify({ subEnabled: true, subPriceRub: 299, subPeriodDays: 30, subMaxTtlDays: 30, subFreeTtlHours: 24 }),
});
check('цены сохранены', setSub.status === 200 && setSub.body?.settings?.subPriceRub === 299, JSON.stringify(setSub.body?.settings));

const grant = await api('/api/admin/subscription', { method: 'PUT', headers: AH, body: JSON.stringify({ login, days: 30 }) });
check('подписка выдана', grant.status === 200 && grant.body?.subscription?.active === true, `status=${grant.status} ${JSON.stringify(grant.body).slice(0, 90)}`);

state = await api('/api/billing/status', { headers: { authorization: `Bearer ${reg.body.token}` } });
check('подписка активна', state.body?.subscription?.active === true, JSON.stringify(state.body?.subscription));
check('доступен выбор срока', state.body?.ttl?.selectable === true, JSON.stringify(state.body?.ttl));
check('потолок 30 дней', state.body?.ttl?.maxHours === 720, String(state.body?.ttl?.maxHours));
check('в вариантах есть 30 дней', state.body?.ttl?.options?.some((o) => o.hours === 720), JSON.stringify(state.body?.ttl?.options));

/* --- подписчик выбирает 30 дней --- */
const fd2 = new FormData();
fd2.append('file', new File(['долгий'], 'Долгий.txt', { type: 'text/plain' }));
fd2.append('pendingTtl', '1');
const up2 = await api('/api/upload', { method: 'POST', headers: { authorization: `Bearer ${reg.body.token}` }, body: fd2 });
const id2 = up2.body.file.id;

const chosen = await api(`/api/file/${id2}/link`, { method: 'POST', headers: H, body: JSON.stringify({ hours: 720 }) });
check('30 дней выбрать можно', chosen.status === 200, `status=${chosen.status} ${JSON.stringify(chosen.body).slice(0, 80)}`);
check('срок 30 дней', Math.abs((chosen.body.file.expiresAt - Date.now()) / 3600000 - 720) < 0.5, `${((chosen.body.file.expiresAt - Date.now()) / 3600000).toFixed(1)} ч`);

const over = await api(`/api/file/${id2}/link`, { method: 'POST', headers: H, body: JSON.stringify({ hours: 1000 }) });
check('больше 30 дней нельзя → 400', over.status === 400, `status=${over.status}`);

/* --- правим срок из кабинета --- */
const edited = await api(`/api/file/${id2}/link`, { method: 'PATCH', headers: H, body: JSON.stringify({ hours: 168 }) });
check('срок правится из кабинета', edited.status === 200 && Math.abs((edited.body.file.expiresAt - Date.now()) / 3600000 - 168) < 0.2, `status=${edited.status}`);

/* --- подписка кончилась --- */
const revoke = await api('/api/admin/subscription', { method: 'PUT', headers: AH, body: JSON.stringify({ login, revoke: true }) });
check('подписка отозвана', revoke.status === 200, `status=${revoke.status}`);

const afterDown = await api(`/api/file/${id2}`, { headers: { authorization: `Bearer ${reg.body.token}` } });
const hoursLeft = (afterDown.body.file.expiresAt - Date.now()) / 3600000;
check('срок срезан до 24 часов', Math.abs(hoursLeft - 24) < 0.5, `${hoursLeft.toFixed(1)} ч`);

/* --- оплата снова: срок возвращается --- */
const regrant = await api('/api/admin/subscription', { method: 'PUT', headers: AH, body: JSON.stringify({ login, days: 30 }) });
check('подписка выдана снова', regrant.status === 200, `status=${regrant.status}`);
const restored = await api(`/api/file/${id2}`, { headers: { authorization: `Bearer ${reg.body.token}` } });
const restoredHours = (restored.body.file.expiresAt - Date.now()) / 3600000;
check('срок вернулся к выбранному (7 дней)', Math.abs(restoredHours - 168) < 1, `${restoredHours.toFixed(1)} ч`);

/* --- без подписки 30 дней выбрать нельзя --- */
await api('/api/admin/subscription', { method: 'PUT', headers: AH, body: JSON.stringify({ login, revoke: true }) });
const blocked = await api(`/api/file/${id2}/link`, { method: 'POST', headers: H, body: JSON.stringify({ hours: 720 }) });
check('без подписки 30 дней → 403', blocked.status === 403, `status=${blocked.status}`);

/* --- список подписок в админке --- */
const list = await api('/api/admin/subscriptions', { headers: { authorization: `Bearer ${adminAuth.body.token}` } });
check('список подписок доступен', list.status === 200 && Array.isArray(list.body?.list), `status=${list.status}`);

/* --- оплата: без секретов должна ругаться, а не падать --- */
const checkout = await api('/api/billing/checkout', { method: 'POST', headers: { authorization: `Bearer ${reg.body.token}` } });
check('без секретов CloudPayments — понятная ошибка', checkout.status === 503 && checkout.body?.error?.code === 'payment_not_configured', `status=${checkout.status} ${JSON.stringify(checkout.body).slice(0, 70)}`);

/* --- подписка выключена админом --- */
await api('/api/admin/settings', { method: 'PUT', headers: AH, body: JSON.stringify({ subEnabled: false }) });
const disabled = await api('/api/billing/checkout', { method: 'POST', headers: { authorization: `Bearer ${reg.body.token}` } });
check('при выключенной оплате — 403', disabled.status === 403 && disabled.body?.error?.code === 'sub_disabled', `status=${disabled.status}`);

/* --- чужой не может править срок --- */
const other = await api('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: `${login}-other`, password: pass }),
});
const otherEdit = await api(`/api/file/${id2}/link`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${other.body.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ hours: 24 }),
});
check('чужой не меняет срок → 403', otherEdit.status === 403, `status=${otherEdit.status}`);

console.log(failed ? `\nпровалено: ${failed}` : '\nвсе проверки пройдены');
process.exit(failed ? 1 : 0);