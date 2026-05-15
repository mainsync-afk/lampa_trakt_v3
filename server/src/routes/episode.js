// episode.js — write-endpoint для toggle отдельного эпизода (D1b).
// POST /api/episode/watch { tmdb, season, episode, watched: true|false }
//
// С v0.5.0: write идёт в writeQueue (FIFO, pacing, retry). Клиент получает
// ok сразу, optimistic-обновление snapshot уже произошло.

import { writeQueue } from '../lib/writeQueue.js';
import { repo } from '../lib/repo.js';
import { getSnapshot } from '../sync/index.js';
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

        // Если карточки нет — on-demand resolve trakt_id и сразу enqueue.
        if (!card) {
            try {
                const resolved = await resolveShowByTmdb(tmdb);
                const body = {
                    shows: [{
                        ids: { tmdb, trakt: resolved.trakt_id },
                        seasons: [{ number: season, episodes: [{ number: episode }] }]
                    }]
                };
                writeQueue.enqueue({
                    kind: watched ? 'addToHistory' : 'removeFromHistory',
                    args: { body }
                    // rollback не нужен — мы и не писали в snapshot
                });
                invalidateShowCache(tmdb);
                return { ok: true, action: watched ? 'added' : 'removed', on_demand: true };
            } catch (err) {
                return reply.code(500).send({ ok: false, error: 'on-demand: ' + String(err.message || err) });
            }
        }

        // Optimistic update episodes_aired
        if (!card.progress) card.progress = {};
        if (!card.progress.episodes_aired) card.progress.episodes_aired = {};
        const epKey = 'S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0');
        const prevValue = card.progress.episodes_aired[epKey];
        if (watched) {
            card.progress.episodes_aired[epKey] = new Date().toISOString();
            if (snap.progress_files) {
                delete snap.progress_files['show:' + tmdb + ':' + epKey];
            }
        } else {
            card.progress.episodes_aired[epKey] = null;
        }

        snap.meta.generated_at = new Date().toISOString();
        await repo.writeSnapshot(snap);

        const body = {
            shows: [{
                ids: { tmdb },
                seasons: [{ number: season, episodes: [{ number: episode }] }]
            }]
        };

        writeQueue.enqueue({
            kind: watched ? 'addToHistory' : 'removeFromHistory',
            args: { body },
            rollback: async () => {
                const s = getSnapshot();
                if (!s || !s.cards?.[k]?.progress?.episodes_aired) return;
                if (prevValue !== undefined) {
                    s.cards[k].progress.episodes_aired[epKey] = prevValue;
                } else {
                    delete s.cards[k].progress.episodes_aired[epKey];
                }
                s.meta.generated_at = new Date().toISOString();
                await repo.writeSnapshot(s);
            }
        });

        return { ok: true, action: watched ? 'added' : 'removed', episode: epKey };
    });
}
