/**
 * Проверка: срок гостя в подсказке следует за настройкой в панели управления.
 * Гоняется против локального воркера.
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

// Админ в этом прогоне — MaxDiWay (см. ADMIN_LOGINS в wrangler.jsonc)
const pass = 'parol-dlya-proverki-2026';
const reg = await api('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: 'MaxDiWay', password: pass }),
});
check('регистрация админа', reg.status === 201 || reg.status === 409, `status=${reg.status} ${JSON.stringify(reg.body).slice(0, 80)}`);
const login = await api('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: 'MaxDiWay', password: pass }),
});
check('вход админа', login.status === 200 && !!login.body?.token, `status=${login.status}`);

for (const hours of [3, 24]) {
  const put = await api('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.body.token}` },
    body: JSON.stringify({ anonymousTtlHours: hours }),
  });
  check(`настройка «гостям ${hours} ч» сохранена`, put.status === 200, `status=${put.status}`);

  const stats = await api('/api/stats');
  check('статистика отдаёт новое значение', stats.body?.settings?.anonymousTtlHours === hours, `${stats.body?.settings?.anonymousTtlHours}`);
}

console.log(failed ? `\nпровалено: ${failed}` : '\nвсе проверки пройдены');
process.exit(failed ? 1 : 0);