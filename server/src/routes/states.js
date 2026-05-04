// states.js — light-endpoint для overlay-значков и progress-bar на превью
// карточек (B1 + B1.5). Возвращает компактный map:
//   { '<tmdb>': { movie?: {...}, show?: {...} } }
// Используется плагином для overlay'я поверх любых карточек в Lampa
// (главная, поиск, source-плагины), без необходимости тащить полные /api/folders.

import { getSnapshot } from '../sync/index.js';

export default async function (app) {
    app.get('/api/cards/states', async (req, reply) => {
        const snap = getSnapshot();
        if (!snap) return reply.code(503).send({ error: 'no snapshot' });
        const progressFiles = snap.progress_files || {};

        const out = {};
        for (const c of Object.values(snap.cards || {})) {
            if (!c || !c.tmdb || !c.type) continue;
            const id = String(c.tmdb);
            if (!out[id]) out[id] = {};
            const entry = {
                trakt_status: c.trakt_status || null,
                in_watchlist: !!c.in_watchlist,
                in_watched: !!c.in_watched,
                in_collection: !!c.in_collection
            };
            // Show progress: completed/aired (для in_progress).
            if (c.type === 'show' && c.progress
                && Number.isFinite(c.progress.completed) && Number.isFinite(c.progress.aired)) {
                entry.progress = {
                    completed: c.progress.completed,
                    aired: c.progress.aired
                };
            }
            // Movie progress: percent paused-position (D1d).
            if (c.type === 'movie') {
                const pf = progressFiles['movie:' + c.tmdb];
                if (pf && Number.isFinite(pf.percent)) {
                    entry.movie_progress = { percent: pf.percent };
                }
            }
            out[id][c.type] = entry;
        }
        return {
            generated_at: snap.meta?.generated_at || null,
            cards: out
        };
    });
}
