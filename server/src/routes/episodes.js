// episodes.js — детальный список эпизодов с watched-состоянием.
// Используется плагином для отрисовки маркеров в Lampa-карточке через
// Lampa.Timeline.update.

import { getSnapshot } from '../sync/index.js';
import { resolveShowByTmdb } from '../lib/resolve.js';

export default async function (app) {
    app.get('/api/show/:tmdb/episodes', async (req, reply) => {
        const tmdb = Number(req.params.tmdb);
        if (!Number.isInteger(tmdb) || tmdb <= 0) {
            return reply.code(400).send({ ok: false, error: 'invalid tmdb' });
        }

        const snap = getSnapshot();
        if (!snap) return reply.code(503).send({ ok: false, error: 'no snapshot' });

        const card = snap.cards?.['show:' + tmdb];
        // Если карточки нет в snapshot — on-demand resolve через Trakt search.
        // Это покрывает случай когда юзер открыл шоу из Lampa-каталога, которое
        // не в его Trakt-картотеке (не watched, не watchlist, etc).
        if (!card) {
            try {
                const resolved = await resolveShowByTmdb(tmdb);
                const ea = resolved.episodes_aired || {};
                const episodes = Object.entries(ea).map(([key, watched_at]) => {
                    const m = key.match(/^S(\d+)E(\d+)$/);
                    if (!m) return null;
                    return {
                        season: Number(m[1]),
                        episode: Number(m[2]),
                        watched: watched_at !== null,
                        watched_at: watched_at || null
                    };
                }).filter(Boolean);
                return {
                    ok: true,
                    tmdb,
                    original_name: resolved.original_name || null,
                    episodes,
                    on_demand: true
                };
            } catch (err) {
                req.log?.warn({ err: String(err.message || err), tmdb }, 'on-demand resolve failed');
                return reply.code(404).send({ ok: false, error: 'show not found' });
            }
        }

        // Возвращаем ВСЕ aired эпизоды с watched-флагом + progress (D1d cross-device).
        const ea = card.progress?.episodes_aired || {};
        const pf = snap.progress_files || {};
        const episodes = Object.entries(ea).map(([key, watched_at]) => {
            const m = key.match(/^S(\d+)E(\d+)$/);
            if (!m) return null;
            const season = Number(m[1]);
            const episode = Number(m[2]);
            const pfKey = 'show:' + tmdb + ':' + key;
            const prog = pf[pfKey] || null;
            return {
                season,
                episode,
                watched: watched_at !== null,
                watched_at: watched_at || null,
                progress: prog ? { time: prog.time, duration: prog.duration, percent: prog.percent } : null
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
