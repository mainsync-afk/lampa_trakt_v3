// episodes.js — детальный список эпизодов с watched-состоянием.
// Используется плагином для отрисовки маркеров в Lampa-карточке через
// Lampa.Timeline.update.

import { getSnapshot } from '../sync/index.js';

export default async function (app) {
    app.get('/api/show/:tmdb/episodes', async (req, reply) => {
        const tmdb = Number(req.params.tmdb);
        if (!Number.isInteger(tmdb) || tmdb <= 0) {
            return reply.code(400).send({ ok: false, error: 'invalid tmdb' });
        }

        const snap = getSnapshot();
        if (!snap) return reply.code(503).send({ ok: false, error: 'no snapshot' });

        const card = snap.cards?.['show:' + tmdb];
        if (!card) {
            return {
                ok: true,
                tmdb,
                original_name: null,
                episodes: []
            };
        }

        const ew = card.progress?.episodes_watched || {};
        const episodes = Object.entries(ew).map(([key, watched_at]) => {
            // key = "S01E03" → season 1, episode 3
            const m = key.match(/^S(\d+)E(\d+)$/);
            if (!m) return null;
            return {
                season: Number(m[1]),
                episode: Number(m[2]),
                watched: true,
                watched_at: watched_at || null
            };
        }).filter(Boolean);

        return {
            ok: true,
            tmdb: card.tmdb,
            original_name: card.original_title || card.title || '',
            episodes
        };
    });
}
