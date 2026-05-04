// card.js — состояние конкретной карточки.
// Вызывается клиентом, например, при открытии sidebar для решения,
// какие tap-кнопки показывать.

import { getSnapshot } from '../sync/index.js';

export default async function (app) {
    app.get('/api/card/:tmdb', async (req, reply) => {
        const tmdb = Number(req.params.tmdb);
        const type = req.query.type === 'movie' ? 'movie' : 'show';
        const snap = getSnapshot();
        if (!snap) return reply.code(503).send({ error: 'no snapshot yet' });

        const k = type + ':' + tmdb;
        const c = snap.cards?.[k];
        if (!c) {
            return {
                tmdb,
                type,
                trakt_id: null,
                in_watchlist: false,
                in_watched: false,
                in_collection: false,
                in_lists: [],
                known: false
            };
        }
        // D1d: подтянем film progress (для type='movie')
        let movie_progress = null;
        if (c.type === 'movie' && snap.progress_files) {
            const pf = snap.progress_files['movie:' + c.tmdb];
            if (pf) movie_progress = { time: pf.time, duration: pf.duration, percent: pf.percent };
        }

        return {
            tmdb: c.tmdb,
            type: c.type,
            trakt_id: c.trakt_id,
            title: c.title,
            year: c.year,
            poster_path: c.poster_path,
            in_watchlist: !!c.in_watchlist,
            in_watched: !!c.in_watched,
            in_collection: !!c.in_collection,
            in_lists: c.in_lists || [],
            trakt_status: c.trakt_status || null,
            show_status: c.show_status || null,
            progress: c.progress || null,
            movie_progress,
            known: true
        };
    });
}
