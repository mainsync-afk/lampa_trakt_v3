// states.js — light-endpoint для overlay-значков на превью карточек (B1).
// Возвращает компактный map: { '<tmdb>': { movie?: {...}, show?: {...} } }.
// Используется плагином для показа Trakt-state badges поверх любых карточек
// в Lampa (главная, поиск, source-плагины), без необходимости тащить полные
// /api/folders.

import { getSnapshot } from '../sync/index.js';

export default async function (app) {
    app.get('/api/cards/states', async (req, reply) => {
        const snap = getSnapshot();
        if (!snap) return reply.code(503).send({ error: 'no snapshot' });

        const out = {};
        for (const c of Object.values(snap.cards || {})) {
            if (!c || !c.tmdb || !c.type) continue;
            const id = String(c.tmdb);
            if (!out[id]) out[id] = {};
            out[id][c.type] = {
                trakt_status: c.trakt_status || null,
                in_watchlist: !!c.in_watchlist,
                in_watched: !!c.in_watched,
                in_collection: !!c.in_collection
            };
        }
        return {
            generated_at: snap.meta?.generated_at || null,
            cards: out
        };
    });
}
