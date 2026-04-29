// tmdb.js — TMDB API client с file-кешем и throttled batch enrichment.

import { repo } from './repo.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const TMDB_KEY = process.env.TMDB_API_KEY;
const TMDB_LANG = process.env.TMDB_LANG || 'ru-RU';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let _cache = null;

async function getCache() {
    if (!_cache) _cache = await repo.readTmdbCache();
    return _cache;
}

async function flushCache() {
    if (_cache) await repo.writeTmdbCache(_cache);
}

function cacheKey(type, tmdbId) {
    return type + ':' + tmdbId;
}

function isFresh(entry) {
    if (!entry || !entry.fetched_at) return false;
    return Date.now() - Date.parse(entry.fetched_at) < TTL_MS;
}

async function fetchOne(type, tmdbId) {
    const method = type === 'movie' ? 'movie' : 'tv';
    const url = `${TMDB_BASE}/${method}/${tmdbId}?api_key=${TMDB_KEY}&language=${encodeURIComponent(TMDB_LANG)}`;
    const res = await fetch(url);
    if (res.status === 404) return null; // карточки нет в TMDB — graceful
    if (!res.ok) throw new Error('TMDB ' + method + '/' + tmdbId + ' -> ' + res.status);
    return res.json();
}

// targets: [{ type: 'movie'|'show', tmdb: number }]
// Возвращает: { 'movie:603': data, 'show:1399': data, ... }
async function enrichMany(targets, { concurrency = 10, force = false } = {}) {
    const cache = await getCache();
    const result = {};
    const toFetch = [];
    for (const t of targets) {
        const k = cacheKey(t.type, t.tmdb);
        const cached = cache[k];
        if (!force && isFresh(cached)) {
            result[k] = cached.data;
        } else {
            toFetch.push(t);
        }
    }
    if (toFetch.length === 0) return result;

    let i = 0;
    async function worker() {
        while (i < toFetch.length) {
            const t = toFetch[i++];
            const k = cacheKey(t.type, t.tmdb);
            try {
                const data = await fetchOne(t.type, t.tmdb);
                if (data) {
                    cache[k] = { data, fetched_at: new Date().toISOString() };
                    result[k] = data;
                } else {
                    result[k] = null;
                }
            } catch (_err) {
                // graceful: оставим карточку без TMDB-данных, попробуем в след. sync
                result[k] = null;
            }
        }
    }
    const n = Math.min(concurrency, toFetch.length);
    await Promise.all(Array(n).fill(0).map(() => worker()));
    await flushCache();
    return result;
}

export const tmdb = {
    enrichMany,
    posterUrl: (poster_path, size = 'w300') => poster_path ? `${TMDB_IMG}/${size}${poster_path}` : null,
    backdropUrl: (backdrop_path, size = 'w500') => backdrop_path ? `${TMDB_IMG}/${size}${backdrop_path}` : null,
    TMDB_IMG
};
