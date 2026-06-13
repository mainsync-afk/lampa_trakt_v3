// scrobble.js — единый эндпоинт событий плеера. Тонкая обёртка над
// lib/scrobbleSessions.js (вся логика и решение watched/resume — там).
//
// POST /api/scrobble { event:'start'|'progress'|'pause'|'stop',
//                      device_id, type:'movie'|'show', tmdb, season?, episode?, progress }

import { scrobbleSessions } from '../lib/scrobbleSessions.js';

const EVENTS = new Set(['start', 'progress', 'pause', 'stop']);

export default async function (app) {
    app.post('/api/scrobble', async (req, reply) => {
        const b = req.body || {};
        const event = String(b.event || '');
        if (!EVENTS.has(event)) {
            return reply.code(400).send({ ok: false, error: 'invalid event' });
        }

        const tmdb = Number(b.tmdb);
        const type = b.type;
        if (!Number.isInteger(tmdb) || tmdb <= 0) {
            return reply.code(400).send({ ok: false, error: 'invalid tmdb' });
        }
        if (type !== 'movie' && type !== 'show') {
            return reply.code(400).send({ ok: false, error: 'invalid type' });
        }

        const season = b.season != null ? Number(b.season) : null;
        const episode = b.episode != null ? Number(b.episode) : null;
        if (type === 'show' && (!Number.isInteger(season) || !Number.isInteger(episode))) {
            return reply.code(400).send({ ok: false, error: 'show requires season+episode' });
        }

        return scrobbleSessions.handle({
            event,
            device_id: b.device_id,
            type, tmdb, season, episode,
            progress: b.progress,
            time: b.time,
            duration: b.duration
        });
    });
}
