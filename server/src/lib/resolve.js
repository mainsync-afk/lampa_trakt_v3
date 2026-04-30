// resolve.js — on-demand резолв show/movie по TMDB id для случаев когда
// карточка не в snapshot (юзер открыл шоу из Lampa-каталога которого
// нет у него в Trakt-картотеке).
//
// Кешируется in-memory на 5 минут чтобы повторные запросы не дёргали Trakt.

import { trakt } from './trakt.js';

const _cache = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 минут

function buildEpisodesAired(p) {
    const episodes_aired = {};
    if (!p || !Array.isArray(p.seasons)) return episodes_aired;
    for (const s of p.seasons) {
        if (!s || !Array.isArray(s.episodes)) continue;
        for (const e of s.episodes) {
            if (!e || typeof e.number !== 'number') continue;
            const sn = String(s.number).padStart(2, '0');
            const en = String(e.number).padStart(2, '0');
            const key = 'S' + sn + 'E' + en;
            episodes_aired[key] = e.completed
                ? (e.last_watched_at || p.last_watched_at || null)
                : null;
        }
    }
    return episodes_aired;
}

export async function resolveShowByTmdb(tmdb) {
    const tnum = Number(tmdb);
    const cached = _cache.get(tnum);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached;

    // Trakt search by tmdb
    const r = await trakt.fetch(`/search/tmdb/${tnum}?type=show`);
    if (!r.ok) throw new Error('trakt search failed: ' + r.status);
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('show not found in trakt');
    const show = arr[0]?.show;
    if (!show || !show.ids) throw new Error('invalid show payload');

    const trakt_id = show.ids.trakt;
    const original_name = show.title || '';
    if (!trakt_id) throw new Error('trakt_id missing');

    // progress fetch
    let episodes_aired = {};
    try {
        const p = await trakt.progressWatched(trakt_id);
        episodes_aired = buildEpisodesAired(p);
    } catch (err) {
        // могут быть права/проблемы — возвращаем пустой
    }

    const out = { tmdb: tnum, trakt_id, original_name, episodes_aired, ts: Date.now() };
    _cache.set(tnum, out);
    return out;
}

export function invalidateShowCache(tmdb) {
    _cache.delete(Number(tmdb));
}
