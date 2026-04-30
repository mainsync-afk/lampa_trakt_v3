// episode.js — write-endpoint для toggle отдельного эпизода (D1b).
// POST /api/episode/watch { tmdb, season, episode, watched: true|false }

import { trakt } from '../lib/trakt.js';
import { repo } from '../lib/repo.js';
import { getSnapshot, triggerBackgroundSync } from '../sync/index.js';
import { resolveShowByTmdb, invalidateShowCache } from '../lib/resolve.js';

export default async function (app) {
    app.post('/api/episode/watch', async (req, reply) => {
        const tmdb = Number(req.body?.tmdb);
        const season = Number(req.body?.season);
        const episode = Number(req.body?.episode);
        const watched = !!req.body?.watched;

        if (!Number.isInteger(tmdb) || tmdb <= 0) {
            return reply.code(400).send({ ok: false, error: 'invalid tmdb' });
        }
        if (!Number.isInteger(season) || season < 0) {
            return reply.code(400).send({ ok: false, error: 'invalid season' });
        }
        if (!Number.isInteger(episode) || episode <= 0) {
            return reply.code(400).send({ ok: false, error: 'invalid episode' });
        }

        const snap = getSnapshot();
        if (!snap) return reply.code(503).send({ ok: false, error: 'no snapshot' });

        const k = 'show:' + tmdb;
        let card = snap.cards?.[k];

        // Если карточки нет — on-demand: резолвим trakt_id, шлём write напрямую,
        // НЕ сохраняем в snapshot (через 5 сек background sync подхватит реальное состояние).
        if (!card) {
            try {
                const resolved = await resolveShowByTmdb(tmdb);
                const body = {
                    shows: [{
                        ids: { tmdb, trakt: resolved.trakt_id },
                        seasons: [{ number: season, episodes: [{ number: episode }] }]
                    }]
                };
                if (watched) await trakt.addToHistory(body);
                else         await trakt.removeFromHistory(body);
                invalidateShowCache(tmdb);
                triggerBackgroundSync(200);
                return { ok: true, action: watched ? 'added' : 'removed', on_demand: true };
            } catch (err) {
                return reply.code(500).send({ ok: false, error: 'on-demand: ' + String(err.message || err) });
            }
        }

        // Optimistic update episodes_watched
        if (!card.progress) card.progress = {};
        if (!card.progress.episodes_watched) card.progress.episodes_watched = {};
        const epKey = 'S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0');
        const prevValue = card.progress.episodes_watched[epKey];
        if (watched) {
            card.progress.episodes_watched[epKey] = new Date().toISOString();
        } else {
            delete card.progress.episodes_watched[epKey];
        }

        snap.meta.generated_at = new Date().toISOString();
        await repo.writeSnapshot(snap);

        // Trakt write — через trakt_id шоу + seasons/episodes payload
        const body = {
            shows: [{
                ids: { tmdb },
                seasons: [{
                    number: season,
                    episodes: [{ number: episode }]
                }]
            }]
        };

        try {
            if (watched) {
                await trakt.addToHistory(body);
            } else {
                await trakt.removeFromHistory(body);
            }
            // background re-sync для обновления completed/aired/next_aired_at и точных watched_at
            triggerBackgroundSync(200);
            return { ok: true, action: watched ? 'added' : 'removed', episode: epKey };
        } catch (err) {
            // rollback
            if (prevValue !== undefined) {
                card.progress.episodes_watched[epKey] = prevValue;
            } else {
                delete card.progress.episodes_watched[epKey];
            }
            await repo.writeSnapshot(snap);
            return reply.code(500).send({ ok: false, error: String(err.message || err) });
        }
    });
}
