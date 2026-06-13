// index.js — Fastify-сервер с роутами и стартом sync-engine.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import * as syncEngine from './sync/index.js';
import { writeQueue } from './lib/writeQueue.js';
import healthRoutes from './routes/health.js';
import foldersRoutes from './routes/folders.js';
import cardRoutes from './routes/card.js';
import syncRoutes from './routes/sync.js';
import tapRoutes from './routes/tap.js';
import episodesRoutes from './routes/episodes.js';
import episodeRoutes from './routes/episode.js';
import movieRoutes from './routes/movie.js';
import progressRoutes from './routes/progress.js';
import statesRoutes from './routes/states.js';
import scrobbleRoutes from './routes/scrobble.js';

const VERSION = '0.6.0';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' }
});
app.appVersion = VERSION;

await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS']
});

// gzip-сжатие ответов >= 1KB. Smart-TV всё разжимают автоматически.
await app.register(compress, {
    encodings: ['gzip', 'br', 'deflate'],
    threshold: 1024
});

// Access-code gate. Если ACCESS_CODE задан в .env — требуем заголовок
// X-Trakt-Code на всех /api/* кроме /api/health. Неверный/отсутствующий код →
// 401 с задержкой ~1с (анти-брутфорс для коротких числовых кодов). Пустой
// ACCESS_CODE → гейт выключен (для безопасного раскатывания: сначала деплой,
// потом задать код в .env + restart).
const ACCESS_CODE = String(process.env.ACCESS_CODE || '').trim();
if (!ACCESS_CODE) {
    app.log.warn('ACCESS_CODE not set — API is open (no access-code gate)');
}
app.addHook('onRequest', async (req, reply) => {
    if (!ACCESS_CODE) return;
    if (req.method === 'OPTIONS') return;             // CORS preflight
    const path = req.url.split('?')[0];
    if (path === '/api/health') return;               // health открыт для проверки доступности
    const code = String(req.headers['x-trakt-code'] || '').trim();
    if (code === ACCESS_CODE) return;
    await new Promise(r => setTimeout(r, 1000));       // анти-брутфорс
    reply.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    return reply.code(401).send({ ok: false, error: 'access_denied' });
});

await syncEngine.init(app.log);

// writeQueue: на каждый успешный Trakt-write дёргаем background-sync,
// чтобы snapshot был свежим (classifier пересчитал status, listed_at и т.п.).
// triggerBackgroundSync coalesces — burst writes → 1 sync.
writeQueue.init({
    log: app.log,
    onSuccess: () => syncEngine.triggerBackgroundSync(200)
});

await app.register(healthRoutes);
await app.register(foldersRoutes);
await app.register(cardRoutes);
await app.register(syncRoutes);
await app.register(tapRoutes);
await app.register(episodesRoutes);
await app.register(episodeRoutes);
await app.register(movieRoutes);
await app.register(progressRoutes);
await app.register(statesRoutes);
await app.register(scrobbleRoutes);

try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`lampa-trakt-server v${VERSION} listening on ${HOST}:${PORT}`);

    // Boot-sync асинхронно — не блокирует старт.
    // Пропустится, если auth.json отсутствует (graceful: сервер живой,
    // /api/folders отдаёт пустой ответ, ошибка видна в /api/health).
    syncEngine.syncOnce()
        .then(r => app.log.info(r, 'boot sync result'))
        .catch(err => app.log.error({ err: String(err) }, 'boot sync error'));

    syncEngine.startPolling();
} catch (err) {
    app.log.error(err);
    process.exit(1);
}
