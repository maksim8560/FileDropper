# Файлообменник (FileDropper)

Файлообменник в стиле Apple Glass: загрузил файл — получил ссылку. Без карт, кошельков,
регистрации и смс.

Фронтенд живёт на **GitHub Pages**, API и хранение файлов — на **Cloudflare Workers + Upstash Blob**.

```
GitHub Pages (public/)                Cloudflare Worker (src/)            Upstash Blob
┌──────────────────────┐  fetch/CORS  ┌────────────────────────┐   REST    ┌──────────┐
│ index.html, app.js,  │ ───────────► │ /api/upload            │ ────────► │ f/<id>/  │
│ styles.css           │              │ /api/file/:id?dl=1     │ ◄──────── │ m/<id>.  │
└──────────────────────┘              │ /api/raw/:id, /stats   │           └──────────┘
                                      └────────────────────────┘
```

## Что умеет

- Загрузка drag & drop, до 4 файлов за раз, до 25 МБ каждый
- Срок жизни ссылки: 1 час / 24 часа / 7 дней / навсегда
- Одноразовые ссылки: файл удаляется сразу после первого скачивания
- Превью картинок, видео, аудио и текста прямо на странице файла
- Удаление файла владельцем (по токену, который хранится в localStorage)
- Cron-чистка просроченных файлов каждые 30 минут
- Тёмная и светлая тема, поддержка `prefers-reduced-motion`, адаптив до 360px

## Запуск локально

```bash
npm install
npx wrangler dev
```

Откроется на `http://localhost:8788`. Без секретов сайт работает в аварийном режиме —
файлы хранятся в памяти воркера и исчезают при перезагрузке (в шапке горит плашка
«аварийный режим»). Для проверки используйте:

```bash
node test-api.mjs      # 40 e2e-проверок API: загрузка, Range, 410/403/404, CORS
```

## Хранилище: включить Upstash Blob

1. Скопируйте `.dev.vars.example` в `.dev.vars` (файл в `.gitignore`) и впишите токен.
2. Для продакшена:

```bash
npx wrangler secret put UPSTASH_BLOB_TOKEN
npx wrangler deploy
```

Адрес бакета задаётся в `wrangler.jsonc` → `vars.UPSTASH_BLOB_URL`
(по умолчанию `https://b2e0533cedea.blob.upstash.io`).

> Токен должен быть именно **Blob REST token** из консоли Upstash (раздел Blob) с
> правами на чтение и запись. Если хранилище отвечает 401, сайт не падает — он
> переключается в аварийный режим и честно пишет об этом в интерфейсе.

Ключи в бакете: `f/<id>/<имя>` — сам файл (имя транслитерируется в ASCII, чтобы
заголовки не ломались), `m/<id>.json` — метаданные (срок, счётчик скачиваний,
хеш токена владельца).

## Публикация

### Frontend → GitHub Pages

Workflow `.github/workflows/deploy-pages.yml` деплоит папку `public/` на каждый пуш
в `main`. В настройках репозитория **Settings → Pages → Source** должно стоять
**GitHub Actions**.

Адрес Worker'а берётся из переменной репозитория
**Settings → Secrets and variables → Actions → Variables → `WORKER_URL`**.
Если её нет — используется значение из `public/config.js`.

Роутинг хешевый (`#/f/<id>`), потому что GitHub Pages не умеет отдавать SPA по
произвольным путям.

### API → Cloudflare Workers

```bash
npx wrangler login
npx wrangler secret put UPSTASH_BLOB_TOKEN   # опционально, см. выше
npx wrangler deploy
```

## API

| Метод    | Путь                  | Назначение                                             |
| -------- | --------------------- | ------------------------------------------------------ |
| `GET`    | `/api/stats`          | Лимиты, сроки, состояние хранилища                     |
| `GET`    | `/api/health`         | Диагностика хранилища                                  |
| `POST`   | `/api/upload`         | Загрузка (multipart: `file`, `ttl`, `once`, `ownerToken`) |
| `GET`    | `/api/file/:id`       | Метаданные файла                                        |
| `GET`    | `/api/file/:id?dl=1`  | Скачивание, поддерживает `Range` (206)                  |
| `GET`    | `/api/raw/:id`        | Поток для превью (`Content-Disposition: inline`)        |
| `DELETE` | `/api/file/:id`       | Удаление, нужен заголовок `x-owner-token`               |

Ошибки возвращаются как `{"error": {"code", "message", "hint"}}`:
`404` — нет такого файла, `410` — истёк срок или одноразовая ссылка погашена,
`413` — больше лимита, `429` —rate limit, `403` — чужой токен удаления.

## Безопасность

- Токен хранилища живёт только в секрете Worker'а, в браузер не попадает
- CSP, `nosniff`, `X-Frame-Options`, `Permissions-Policy` на всех ответах
- Удаление и «одноразовость» защищены SHA-256 токена, а не тем, что ссылка «не угадана»
- Лимит: 60 загрузок за 10 минут с одного IP, 25 МБ на файл

## Структура

```
public/          статика для Pages (index.html, app.js, styles.css, config.js)
src/index.js     Worker: маршруты API, CORS, заголовки безопасности, cron
src/storage.js   Upstash Blob + аварийное хранилище в памяти изолята
test-api.mjs     e2e-тесты API
```