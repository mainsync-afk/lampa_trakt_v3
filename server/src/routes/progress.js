// progress.js — D1d cross-device прогресс просмотра.
// POST /api/progress { tmdb, type, season?, episode?, time, duration, percent }
//   сохраняет snapshot.progress_files
// progress_files keys:
//   movie:603                       — фильм
//   show:1399:S01E05                — эпизод сериала

import { repo } from '../lib/repo.js';
import { getSnapshot } from '../sync/index.js';

function buildKey(type, tmdb, season, episode) {
    if (type === 'movie') return 'movie:' + tmdb;
    if (type === 'show' && Number.isInteger(season) && Number.isInteger(episode)) {
        const sn = String(season).padStart(2, '0');
        const en = String(episode).padStart(2, '0');
        return 'show:' + tmdb + ':S' + sn + 'E' + en;
    }
    return null;
}

export default async function (app) {
    app.post('/api/progress', async (req, reply) => {
        const tmdb = Number(req.body?.tmdb);
        const type = req.body?.type;
        const season = req.body?.season != null ? Number(req.body.season) : null;
        const episode = req.body?.episode != null ? Number(req.body.episode) : null;
        const time = Math.max(0, Math.floor(Number(req.body?.time) || 0));
        const duration = Math.max(0, Math.floor(Number(req.body?.duration) || 0));
        const percent = Math.max(0, Math.min(100, Number(req.body?.percent) || 0));

        if (!Number.isInteger(tmdb) || tmdb <= 0) {
            return reply.code(400).send({ ok: false, error: 'invalid tmdb' });
        }
        if (type !== 'movie' && type !== 'show') {
            return reply.code(400).send({ ok: false, error: 'invalid type' });
        }
        if (duration <= 0) {
            return reply.code(400).send({ ok: false, error: 'invalid duration' });
        }

        const key = buildKey(type, tmdb, season, episode);
        if (!key) return reply.code(400).send({ ok: false, error: 'invalid key params' });

        const snap = getSnapshot();
        if (!snap) return reply.code(503).send({ ok: false, error: 'no snapshot' });

        if (!snap.progress_files) snap.progress_files = {};
        snap.progress_files[key] = {
            time, duration, percent,
            updated_at: new Date().toISOString()
        };
        snap.meta.generated_at = new Date().toISOString();
        await repo.writeSnapshot(snap);

        return { ok: true, key };
    });

    // GET для одного фильма или для всех эпизодов шоу
    app.get('/api/progress/:tmdb', async (req, reply) => {
        const tmdb = Number(req.params.tmdb);
        const type = req.query.type === 'movie' ? 'movie' : 'show';
        const snap = getSnapshot();
        if (!snap) return reply.code(503).send({ ok: false, error: 'no snapshot' });
        if (!snap.progress_files) return { ok: true, items: [] };

        const items = [];
        if (type === 'movie') {
            const k = 'movie:' + tmdb;
            if (snap.progress_files[k]) {
                items.push({ tmdb, type: 'movie', ...snap.progress_files[k] });
            }
        } else {
            const prefix = 'show:' + tmdb + ':';
            for (const [k, v] of Object.entries(snap.progress_files)) {
                if (k.startsWith(prefix)) {
                    const m = k.match(/^show:\d+:S(\d+)E(\d+)$/);
                    if (m) {
                        items.push({
                            tmdb, type: 'show',
                            season: Number(m[1]),
                            episode: Number(m[2]),
                            ...v
                        });
                    }
                }
            }
        }
        return { ok: true, items };
    });
}
