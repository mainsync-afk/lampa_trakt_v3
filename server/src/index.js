// index.js — Fastify-сервер с роутами и стартом sync-engine.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import * as syncEngine from './sync/index.js';
import healthRoutes from './routes/health.js';
import foldersRoutes from './routes/folders.js';
import cardRoutes from './routes/card.js';
import syncRoutes from './routes/sync.js';
import tapRoutes from './routes/tap.js';

const VERSION = '0.4.1';
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

await syncEngine.init(app.log);

await app.register(healthRoutes);
await app.register(foldersRoutes);
await app.register(cardRoutes);
await app.register(syncRoutes);
await app.register(tapRoutes);

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
