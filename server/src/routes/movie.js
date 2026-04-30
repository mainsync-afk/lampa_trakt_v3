// movie.js — set-style mark для фильма (D1c: auto-mark при ≥80% просмотре).
// POST /api/movie/watch { tmdb, watched: true|false }

import { trakt } from '../lib/trakt.js';
import { repo } from '../lib/repo.js';
import { getSnapshot, triggerBackgroundSync } from '../sync/index.js';

export default async function (app) {
    app.post('/api/movie/watch', async (req, reply) => {
        const tmdb = Number(req.body?.tmdb);
        const watched = !!req.body?.watched;

        if (!Number.isInteger(tmdb) || tmdb <= 0) {
            return reply.code(400).send({ ok: false, error: 'invalid tmdb' });
        }

        const snap = getSnapshot();
        if (!snap) return reply.code(503).send({ ok: false, error: 'no snapshot' });

        const k = 'movie:' + tmdb;
        let card = snap.cards?.[k];
        // Если фильма нет в snapshot — создаём минимальный (новая карточка).
        if (!card) {
            card = {
                tmdb, type: 'movie', trakt_id: null, imdb_id: null,
                title: '', original_title: '', year: null, release_date: '',
                poster_path: null, vote_average: 0,
                in_watchlist: false, in_watched: false, in_collection: false, in_lists: [],
                listed_at: null, last_watched_at: null, collected_at: null, list_listed_at: {},
                trakt_status: null
            };
            snap.cards[k] = card;
        }

        // Idempotent: если уже в нужном состоянии — noop
        if (!!card.in_watched === watched) {
            return { ok: true, action: 'noop', state: card.in_watched };
        }

        // Optimistic update
        const prev = card.in_watched;
        card.in_watched = watched;
        if (watched) card.last_watched_at = new Date().toISOString();
        snap.meta.generated_at = new Date().toISOString();
        await repo.writeSnapshot(snap);

        // Trakt write
        const body = { movies: [{ ids: { tmdb } }] };
        try {
            if (watched) {
                await trakt.addToHistory(body);
            } else {
                await trakt.removeFromHistory(body);
            }
            triggerBackgroundSync(200);
            return { ok: true, action: watched ? 'added' : 'removed' };
        } catch (err) {
            // rollback
            card.in_watched = prev;
            await repo.writeSnapshot(snap);
            return reply.code(500).send({ ok: false, error: String(err.message || err) });
        }
    });
}
