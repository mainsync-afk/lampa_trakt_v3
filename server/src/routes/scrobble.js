// scrobble.js — проксирование Trakt scrobble (start/pause/stop) для live-плеера.
//
// Отдельный лёгкий путь, НЕ через writeQueue: scrobble должен быть «живым»,
// а дедуп у него собственный на стороне Trakt (409 + expires_at). На stop с
// progress >= 80% Trakt сам помечает watched (в историю) — порог считаем НЕ мы.
//
// POST /api/scrobble/{start|pause|stop}  { tmdb, type:'movie'|'show', season?, episode?, progress }

import { trakt } from '../lib/trakt.js';
import { triggerBackgroundSync } from '../sync/index.js';

const ACTIONS = new Set(['start', 'pause', 'stop']);

function buildBody(type, tmdb, season, episode, progress) {
    const p = Math.max(0, Math.min(100, Number(progress) || 0));
    if (type === 'movie') return { movie: { ids: { tmdb } }, progress: p };
    return { show: { ids: { tmdb } }, episode: { season, number: episode }, progress: p };
}

export default async function (app) {
    app.post('/api/scrobble/:action', async (req, reply) => {
        const action = String(req.params.action || '');
        if (!ACTIONS.has(action)) {
            return reply.code(400).send({ ok: false, error: 'invalid action' });
        }

        const tmdb = Number(req.body?.tmdb);
        const type = req.body?.type;
        const season = req.body?.season != null ? Number(req.body.season) : null;
        const episode = req.body?.episode != null ? Number(req.body.episode) : null;
        const progress = Number(req.body?.progress) || 0;

        if (!Number.isInteger(tmdb) || tmdb <= 0) {
            return reply.code(400).send({ ok: false, error: 'invalid tmdb' });
        }
        if (type !== 'movie' && type !== 'show') {
            return reply.code(400).send({ ok: false, error: 'invalid type' });
        }
        if (type === 'show' && (!Number.isInteger(season) || !Number.isInteger(episode))) {
            return reply.code(400).send({ ok: false, error: 'show requires season+episode' });
        }

        const body = buildBody(type, tmdb, season, episode, progress);
        try {
            const r = await trakt.fetch('/scrobble/' + action, {
                method: 'POST',
                body: JSON.stringify(body)
            });
            // 409 — уже скробблилось недавно (дедуп Trakt). Не ошибка.
            if (r.status === 409) return { ok: true, deduped: true };
            // 422 — progress < 1% на start; Trakt игнорирует. Не ошибка.
            if (r.status === 422) return { ok: true, ignored: true };
            if (!r.ok) {
                const t = await r.text().catch(() => '');
                req.log?.warn({ action, status: r.status, body: t.slice(0, 200) }, 'scrobble failed');
                return reply.code(502).send({ ok: false, error: 'trakt ' + r.status });
            }
            const data = await r.json().catch(() => ({}));
            // stop с >= 80% → Trakt пометил watched. Дёрнем фоновый sync,
            // чтобы snapshot/classifier подхватили (coalesce внутри).
            if (action === 'stop') {
                try { triggerBackgroundSync(300); } catch (_) {}
            }
            return { ok: true, action: data.action || action, progress: data.progress };
        } catch (err) {
            req.log?.warn({ err: String(err.message || err) }, 'scrobble error');
            return reply.code(502).send({ ok: false, error: String(err.message || err) });
        }
    });
}
