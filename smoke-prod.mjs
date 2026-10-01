/** Дымовой тест новой схемы загрузки: подпись → PUT → PUT → complete. */
const B = process.env.BASE || 'https://filedropper-api.savin-maksim952.workers.dev';

const out = [];
const check = (name, ok, detail = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}`);

const j = async (p, o = {}) => {
  const r = await fetch(B + p, o);
  const t = await r.text();
  let b = null;
  try { b = JSON.parse(t); } catch { b = t.slice(0, 120); }
  return { s: r.status, b };
};

const fileName = 'Проверка загрузки.txt';
const payload = new TextEncoder().encode('новая схема загрузки работает');

const sign = await j('/api/upload/sign', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: fileName,
    type: 'text/plain',
    size: payload.byteLength,
    ttl: 168,
    once: false,
    ownerToken: 'smoke-owner',
  }),
});

check('подпись выдана', sign.s === 201, `status=${sign.s} ${JSON.stringify(sign.b).slice(0, 120)}`);
check('имя с кириллицей сохранено', sign.b?.file?.name === fileName, sign.b?.file?.name);
const hours = sign.b?.file ? (sign.b.file.expiresAt - Date.now()) / 3600000 : null;
check('гость получил 1 час (просил 7 дней)', hours !== null && Math.abs(hours - 1) < 0.05, `${hours?.toFixed(2)} ч`);
check('есть подпись на файл и на метаданные', !!sign.b?.payload?.url && !!sign.b?.meta?.url, 'ok');

// PUT файла
const putFile = await fetch(sign.b.payload.url, {
  method: 'PUT',
  headers: sign.b.payload.headers,
  body: payload,
});
check('файл залит по подписанной ссылке', putFile.status === 200, `status=${putFile.status}`);

// PUT метаданных — ровно те байты, что подписаны
const putMeta = await fetch(sign.b.meta.url, {
  method: 'PUT',
  headers: sign.b.meta.headers,
  body: new TextEncoder().encode(sign.b.metaBody),
});
check('метаданные залиты', putMeta.status === 200, `status=${putMeta.status}`);

// Фиксация
const commit = await j('/api/upload/complete', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: sign.b.file.id }),
});
check('загрузка зафиксирована', commit.s === 200, `status=${commit.s} ${JSON.stringify(commit.b).slice(0, 100)}`);

// Скачивание
const dl = await fetch(`${B}/api/file/${sign.b.file.id}?dl=1`);
const text = await dl.text();
check('файл скачивается целиком', text === 'новая схема загрузки работает', text.slice(0, 40));
check('имя файла в заголовке', (dl.headers.get('content-disposition') || '').includes('filename*='), dl.headers.get('content-disposition'));

// Превью
const raw = await fetch(`${B}/api/raw/${sign.b.file.id}`);
check('превью доступно', raw.status === 200, `status=${raw.status}`);

// Неверный id при фиксации
const badCommit = await j('/api/upload/complete', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'zzzzzzzz' }),
});
check('фиксация несуществующего → 409', badCommit.s === 409, `status=${badCommit.s}`);

// Уборка
const del = await j(`/api/file/${sign.b.file.id}`, {
  method: 'DELETE',
  headers: { 'x-owner-token': 'smoke-owner' },
});
check('владелец удалил файл', del.s === 200, `status=${del.s}`);

console.log('');
console.log(out.join('\n'));
console.log(`\nПровалено: ${out.filter((l) => l.startsWith('FAIL')).length}`);
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);