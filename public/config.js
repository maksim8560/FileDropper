/**
 * Конфигурация клиента Файлообменника.
 *
 * apiBase — адрес Worker'а с API и хранилищем файлов.
 *   ""                       → API на том же домене (wrangler dev, сайт на самом Worker'е)
 *   "https://…workers.dev"   → фронт на GitHub Pages, API на отдельном Worker'е
 *
 * Значение ниже подставляется на деплое Pages, если в репозитории задана
 * переменная WORKER_URL (Settings → Secrets and variables → Actions → Variables).
 * Иначе используется то, что записано здесь.
 */
window.FILEX = {
  apiBase: 'https://filedropper-api.sonora-online.workers.dev',
};