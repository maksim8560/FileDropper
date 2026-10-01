/**
 * Проверка новой механики: срок выбирают после загрузки, ссылка появляется
 * вместе с выбором. Гоняется против локального воркера (BASE, по умолчанию :8788).
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

const login = `ttl-${Date.now().toString(36)}`;
const pass = 'parol-dlya-proverki-2026';

// Аккаунт
const reg = await api('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: pass }),
});
check('регистрация', reg.status === 201 && !!reg.body?.token, `status=${reg.status}`);
const H = { authorization: `Bearer ${reg.body.token}`, 'content-type': 'application/json' };

// Загрузка с отложенным сроком
const bytes = new TextEncoder().encode('файл для проверки срока');
const sign = await api('/api/upload/sign', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    name: 'Проверка.txt',
    type: 'text/plain',
    size: bytes.byteLength,
    once: false,
    ownerToken: 'own-ttl-test',
    pendingTtl: true,
  }),
});
check('подпись отдана или аварийный путь', sign.status === 200 || sign.status === 201, `status=${sign.status}`);

let id;
let uploaded;

if (sign.body?.memory) {
  // Аварийный режим (память): файл идёт через Worker одним запросом.
  const fd = new FormData();
  fd.append('file', new File([bytes], 'Проверка.txt', { type: 'text/plain' }));
  fd.append('ttl', '24');
  fd.append('once', '0');
  fd.append('pendingTtl', '1');
  fd.append('ownerToken', 'own-ttl-test');
  const up = await api('/api/upload', { method: 'POST', headers: { authorization: `Bearer ${reg.body.token}` }, body: fd });
  check('аварийная загрузка', up.status === 201, `status=${up.status}`);
  check('срок отложен', up.body?.file?.ttlPending === true, JSON.stringify(up.body?.file));
  uploaded = up.body;
} else {
  check('файл залит', (await fetch(sign.body.payload.url, { method: 'PUT', headers: sign.body.payload.headers, body: bytes })).status === 200);
  check(
    'метаданные залиты',
    (await fetch(sign.body.meta.url, { method: 'PUT', headers: sign.body.meta.headers, body: new TextEncoder().encode(sign.body.metaBody) })).status === 200,
  );
  const done = await api('/api/upload/complete', { method: 'POST', headers: H, body: JSON.stringify({ id: sign.body.file.id }) });
  check('загрузка зафиксирована', done.status === 200, `status=${done.status}`);
  check('после загрузки срок всё ещё не выбран', done.body?.file?.ttlPending === true, JSON.stringify(done.body?.file));
  uploaded = done.body;
}

id = uploaded.file.id;

// Гость без сессии выбрать срок не может
const noAuth = await api(`/api/file/${id}/link`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ hours: 24 }),
});
check('без входа и без токена → 403', noAuth.status === 403, `status=${noAuth.status}`);

// Чужой аккаунт — тоже нет
const other = await api('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: `${login}-x`, password: pass }),
});
const otherTtl = await api(`/api/file/${id}/link`, {
  method: 'POST',
  headers: { authorization: `Bearer ${other.body.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ hours: 24 }),
});
check('чужой аккаунт не может выбрать срок → 403', otherTtl.status === 403, `status=${otherTtl.status}`);

// Мусорный срок
const bad = await api(`/api/file/${id}/link`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ hours: 0 }),
});
check('срок вне диапазона → 400', bad.status === 400, `status=${bad.status}`);

// Без подписки дольше бесплатного срока нельзя
const tooLong = await api(`/api/file/${id}/link`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ hours: 168 }),
});
check('7 дней без подписки → 403', tooLong.status === 403, `status=${tooLong.status}`);

// Выбор срока
const chosen = await api(`/api/file/${id}/link`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ hours: 24 }),
});
check('срок выбран → 200', chosen.status === 200, `status=${chosen.status} ${JSON.stringify(chosen.body).slice(0, 90)}`);
check('ссылка вернулась вместе со сроком', chosen.body?.links?.page === `/f/${id}`, JSON.stringify(chosen.body?.links));
check('срок помечен как выбранный', chosen.body?.file?.ttlPending === false, JSON.stringify(chosen.body?.file));
const hours = (chosen.body.file.expiresAt - Date.now()) / 3600000;
check('срок примерно 24 часа', Math.abs(hours - 24) < 0.2, `${hours.toFixed(2)} ч`);

// Созданную ссылку можно укоротить, но не удлинить без подписки
const shorter = await api(`/api/file/${id}/link`, {
  method: 'PATCH',
  headers: H,
  body: JSON.stringify({ hours: 1 }),
});
check(
  'срок можно укоротить',
  shorter.status === 200 && Math.abs((shorter.body.file.expiresAt - Date.now()) / 3600000 - 1) < 0.2,
  `status=${shorter.status}`,
);

const longer = await api(`/api/file/${id}/link`, {
  method: 'PATCH',
  headers: H,
  body: JSON.stringify({ hours: 168 }),
});
check('без подписки удлинить нельзя → 403', longer.status === 403, `status=${longer.status}`);

// Индекс кабинета обновился
const files = await api('/api/me/files', { headers: { authorization: `Bearer ${reg.body.token}` } });
const entry = files.body?.files?.find((f) => f.id === id);
check('в кабинете срок обновлён', entry && entry.ttlPending === false, JSON.stringify(entry));
// Последнее успешное изменение срока было на 1 час — он и должен быть в индексе
check('в кабинете виден правильный срок', entry && Math.abs((entry.expiresAt - Date.now()) / 3600000 - 1) < 0.2, String(entry?.expiresAt));

// Файл работает
const dl = await fetch(`${BASE}/api/file/${id}?dl=1`);
check('файл скачивается', dl.status === 200 && (await dl.text()) === 'файл для проверки срока', `status=${dl.status}`);

// Уборка
const del = await api(`/api/file/${id}`, { method: 'DELETE', headers: H });
check('удаление', del.status === 200, `status=${del.status}`);

console.log(failed ? `\nпровалено: ${failed}` : '\nвсе проверки пройдены');
process.exit(failed ? 1 : 0);