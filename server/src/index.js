import Fastify from 'fastify';
import cors from '@fastify/cors';

const VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({
    logger: {
        level: process.env.LOG_LEVEL || 'info'
    }
});

await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS']
});

// Health endpoint — для проверки что сервер живой
app.get('/api/health', async () => ({
    ok: true,
    version: VERSION,
    ts: new Date().toISOString(),
    uptime_s: Math.round(process.uptime())
}));

// Stub: структура папок, мапящая модель Trakt 1:1 на Lampa.
// Day 1 отдаёт пустые папки. Sync engine появится в Day 2-3.
app.get('/api/folders', async () => ({
    generated_at: new Date().toISOString(),
    snapshot_age_s: null,
    folders: [
        { id: 'watchlist',      title: 'Watchlist',        count: 0, items: [] },
        { id: 'watched_movies', title: 'Watched Movies',   count: 0, items: [] },
        { id: 'watched_shows',  title: 'Watched Shows',    count: 0, items: [] },
        { id: 'collection',     title: 'Collection',       count: 0, items: [] }
    ],
    custom_lists: []
}));

// Stub: состояние конкретной карточки.
// Параметр type: 'movie' | 'show'.
app.get('/api/card/:tmdb', async (req) => {
    const { tmdb } = req.params;
    const type = req.query.type || 'show';
    return {
        tmdb: Number(tmdb),
        type,
        in_watchlist: false,
        in_watched: false,
        in_collection: false,
        in_lists: []
    };
});

try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`lampa-trakt-server v${VERSION} listening on ${HOST}:${PORT}`);
} catch (err) {
    app.log.error(err);
    process.exit(1);
}
