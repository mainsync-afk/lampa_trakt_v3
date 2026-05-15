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

const VERSION = '0.5.0';
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
