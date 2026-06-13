// scrobbleSessions.js — серверный авторитет по scrobble.
//
// Плагин шлёт сырые события (start / progress-heartbeat / pause / stop) + device_id.
// Сервер держит живые сессии в памяти и сам решает, что слать в Trakt:
//   start  → scrobble/start (для «сейчас играет»)
//   pause  → если progress >= 80% → scrobble/stop (watched), иначе scrobble/pause
//   stop   → scrobble/stop (>=80% watched, <80% resume-точка)
// Watchdog финализирует «мёртвые» сессии: если клиент замолчал (kill/краш/обрыв) —
// сервер сам шлёт scrobble/stop с последним прогрессом. Это обязательно: брошенная
// watching-сессия у Trakt гаснет БЕЗ отметки watched, т.е. без stop досмотр теряется.

import { trakt } from './trakt.js';
import { triggerBackgroundSync } from '../sync/index.js';

const WATCHDOG_INTERVAL_MS = 30000;   // как часто проверяем сессии
const SESSION_TIMEOUT_MS = 120000;    // тишина дольше — клиент считается мёртвым
const WATCHED_THRESHOLD = 80;         // порог Trakt для watched
const TRAKT_POST_MIN_GAP_MS = 1100;   // лимит Trakt: 1 POST/сек

const _state = { sessions: new Map(), log: null, timer: null, lastTraktPostAt: 0 };

function buildBody(s) {
    const p = Math.max(0, Math.min(100, Number(s.progress) || 0));
    if (s.type === 'movie') return { movie: { ids: { tmdb: s.tmdb } }, progress: p };
    return { show: { ids: { tmdb: s.tmdb } }, episode: { season: s.season, number: s.episode }, progress: p };
}

async function traktScrobble(action, s) {
    // мягкий pacing под лимит 1 POST/сек
    const wait = Math.max(0, _state.lastTraktPostAt + TRAKT_POST_MIN_GAP_MS - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _state.lastTraktPostAt = Date.now();

    let result = { ok: false };
    try {
        const r = await trakt.fetch('/scrobble/' + action, { method: 'POST', body: JSON.stringify(buildBody(s)) });
        if (r.status === 409) result = { ok: true, deduped: true };       // уже скробблилось — норм
        else if (r.status === 422) result = { ok: true, ignored: true };  // progress<1% — норм
        else if (!r.ok) { _state.log?.warn({ action, status: r.status }, 'scrobble trakt fail'); }
        else result = { ok: true };
    } catch (err) {
        _state.log?.warn({ action, err: String(err.message || err) }, 'scrobble trakt err');
    }
    if (action === 'stop' && result.ok) {
        try { triggerBackgroundSync(500); } catch (_) {}
    }
    return result;
}

function sessionKey(deviceId) {
    return String(deviceId || 'unknown');
}

// Процент считаем из time/duration (сырые секунды от клиента). Если их нет —
// fallback на присланный progress. Так логика порога 80% живёт здесь, на сервере.
function effProgress(p) {
    const t = Number(p.time);
    const d = Number(p.duration);
    if (Number.isFinite(t) && Number.isFinite(d) && d > 0) {
        return Math.max(0, Math.min(100, Math.round((t / d) * 100)));
    }
    return Math.max(0, Math.min(100, Number(p.progress) || 0));
}

export async function handle(p) {
    const event = p.event;
    const key = sessionKey(p.device_id);

    if (event === 'start') {
        const s = {
            device_id: p.device_id, type: p.type, tmdb: p.tmdb,
            season: p.season ?? null, episode: p.episode ?? null,
            progress: effProgress(p),
            time: Number(p.time) || 0, duration: Number(p.duration) || 0,
            last_update: Date.now()
        };
        _state.sessions.set(key, s);
        return traktScrobble('start', s);
    }

    const s = _state.sessions.get(key);

    if (event === 'progress') {
        if (s) {
            s.progress = effProgress(p);
            s.time = Number(p.time) || s.time;
            s.duration = Number(p.duration) || s.duration;
            s.last_update = Date.now();
        }
        return { ok: true };
    }

    if (event === 'pause') {
        if (!s) return { ok: true };
        s.progress = effProgress(p);
        s.time = Number(p.time) || s.time;
        s.duration = Number(p.duration) || s.duration;
        s.last_update = Date.now();
        if (s.progress >= WATCHED_THRESHOLD) {   // пауза в конце → сразу фиксируем watched
            _state.sessions.delete(key);
            return traktScrobble('stop', s);
        }
        return traktScrobble('pause', s);
    }

    if (event === 'stop') {
        const sess = s || {
            device_id: p.device_id, type: p.type, tmdb: p.tmdb,
            season: p.season ?? null, episode: p.episode ?? null
        };
        sess.progress = effProgress(p);
        _state.sessions.delete(key);
        return traktScrobble('stop', sess);
    }

    return { ok: false, error: 'unknown event' };
}

async function runWatchdog() {
    const now = Date.now();
    for (const [key, s] of _state.sessions) {
        if (now - s.last_update > SESSION_TIMEOUT_MS) {
            _state.sessions.delete(key);
            _state.log?.info({ device: key, type: s.type, tmdb: s.tmdb, progress: s.progress }, 'scrobble watchdog finalize');
            try { await traktScrobble('stop', s); } catch (_) {}
        }
    }
}

export function init(log) {
    _state.log = log;
    if (_state.timer) clearInterval(_state.timer);
    _state.timer = setInterval(() => { runWatchdog().catch(() => {}); }, WATCHDOG_INTERVAL_MS);
    log?.info({ timeout_ms: SESSION_TIMEOUT_MS }, 'scrobble sessions watchdog started');
}

export const scrobbleSessions = { init, handle };
