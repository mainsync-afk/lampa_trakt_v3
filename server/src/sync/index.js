// sync/index.js — главный sync-engine.
// Стратегия: poll /sync/last_activities каждые SYNC_POLL_INTERVAL_SEC секунд.
// При изменении любых таймстампов — полный re-fetch всех Trakt-секций
// (8-15 запросов, дешевле и проще, чем точечный sync).
// TMDB enrich только для карточек, отсутствующих в кеше или с истёкшим TTL.

import { trakt } from '../lib/trakt.js';
import { repo } from '../lib/repo.js';
import { normalizeTraktSnapshot } from './normalize.js';
import { enrichCards } from './enrich.js';
import { classifyAll } from './classifier.js';

const POLL_INTERVAL_SEC = Number(process.env.SYNC_POLL_INTERVAL_SEC || 60);

const _state = {
    snapshot: null,
    last_activities: null,
    syncing: false,
    queueAfterSync: false,
    pollTimer: null,
    lastError: null,
    lastSyncTookMs: null,
    log: null
};

export async function init(log) {
    _state.log = log;
    _state.snapshot = await repo.readSnapshot();
    if (_state.snapshot) {
        _state.last_activities = _state.snapshot.meta?.last_activities || null;
    }
    log.info({
        has_snapshot: !!_state.snapshot,
        items: _state.snapshot ? Object.keys(_state.snapshot.cards || {}).length : 0,
        poll_interval_sec: POLL_INTERVAL_SEC
    }, 'sync init');
}

export function getSnapshot() {
    return _state.snapshot;
}

export function getStatus() {
    const snap = _state.snapshot;
    return {
        has_snapshot: !!snap,
        syncing: _state.syncing,
        generated_at: snap?.meta?.generated_at || null,
        full_sync_at: snap?.meta?.full_sync_at || null,
        cards_count: snap ? Object.keys(snap.cards || {}).length : 0,
        lists_count: snap ? (snap.lists || []).length : 0,
        last_error: _state.lastError,
        last_sync_took_ms: _state.lastSyncTookMs,
        poll_interval_sec: POLL_INTERVAL_SEC,
        last_activities_all: _state.last_activities?.all || null
    };
}

function activitiesChanged(prev, curr) {
    if (!prev) return true;
    return JSON.stringify(prev) !== JSON.stringify(curr);
}

// Возвращает true если в snapshot есть watched-shows без progress
// или вообще карточки без trakt_status. Используется для миграции
// после расширения структуры snapshot — чтобы автоматически re-sync.
function snapshotNeedsMigration(snap) {
    if (!snap || !snap.cards) return false;
    for (const c of Object.values(snap.cards)) {
        if (c.trakt_status === undefined) return true;
        if (c.type === 'show' && c.in_watched && !c.progress) return true;
        // v0.4.2: добавлены listed_at / last_watched_at для сортировки
        if (c.in_watchlist && c.listed_at === undefined) return true;
        if (c.in_watched && c.last_watched_at === undefined) return true;
    }
    return false;
}

async function fetchAll() {
    const [
        watchlistMovies,
        watchlistShows,
        watchedMovies,
        watchedShows,
        collectionMovies,
        collectionShows,
        lists
    ] = await Promise.all([
        trakt.watchlist('movies'),
        trakt.watchlist('shows'),
        trakt.watched('movies'),
        trakt.watched('shows'),
        trakt.collection('movies'),
        trakt.collection('shows'),
        trakt.lists()
    ]);

    const listItems = {};
    if (Array.isArray(lists) && lists.length > 0) {
        const arr = await Promise.all(
            lists.map(l => trakt.listItems(l.ids.trakt).then(items => [l.ids.trakt, items]))
        );
        for (const [id, items] of arr) listItems[id] = items;
    }

    return {
        watchlistMovies, watchlistShows,
        watchedMovies, watchedShows,
        collectionMovies, collectionShows,
        lists, listItems
    };
}

async function fetchProgressForWatched(cards, log) {
    // Дёргаем /shows/<id>/progress/watched для всех show с in_watched=true.
    // Throttled до 8 параллельных, чтобы не упереться в Trakt rate-limit.
    const targets = Object.values(cards).filter(c =>
        c.type === 'show' && c.in_watched && c.trakt_id
    );
    if (targets.length === 0) return;

    log.info({ count: targets.length }, 'sync: fetching show progress');
    const concurrency = 8;
    let i = 0;
    let failed = 0;
    async function worker() {
        while (i < targets.length) {
            const c = targets[i++];
            try {
                const p = await trakt.progressWatched(c.trakt_id);
                c.progress = {
                    completed: Number(p.completed) || 0,
                    aired: Number(p.aired) || 0,
                    next_aired_at: p.next_episode?.first_aired || null,
                    last_watched_at: p.last_watched_at || null
                };
            } catch (err) {
                failed++;
                log.warn({ err: String(err.message || err), tmdb: c.tmdb }, 'progress fetch failed');
            }
        }
    }
    const n = Math.min(concurrency, targets.length);
    await Promise.all(Array(n).fill(0).map(() => worker()));
    if (failed > 0) log.warn({ failed }, 'some progress fetches failed');
}

function activitiesEpisodesChanged(prev, curr) {
    const a = prev?.episodes?.watched_at;
    const b = curr?.episodes?.watched_at;
    return a !== b;
}

async function performSync(activities) {
    const t0 = Date.now();
    _state.log.info('sync: fetching trakt');
    const raw = await fetchAll();

    _state.log.info('sync: normalizing');
    const cards = normalizeTraktSnapshot(raw);

    // Carryover из старого snapshot — display-поля + progress + show_status.
    if (_state.snapshot && _state.snapshot.cards) {
        const old = _state.snapshot.cards;
        for (const k of Object.keys(cards)) {
            const o = old[k];
            if (!o) continue;
            // TMDB-обогащение
            if (o.poster_path) {
                cards[k].poster_path = o.poster_path;
                cards[k].vote_average = o.vote_average;
                cards[k].title = o.title || cards[k].title;
                cards[k].original_title = o.original_title || cards[k].original_title;
                cards[k].release_date = o.release_date || cards[k].release_date;
                if (cards[k].type === 'show') {
                    cards[k].number_of_seasons = o.number_of_seasons || cards[k].number_of_seasons;
                }
            }
            // show metadata (если в свежих данных не пришло)
            if (cards[k].type === 'show' && !cards[k].show_status && o.show_status) {
                cards[k].show_status = o.show_status;
            }
            // Progress — переносим как есть; обновим ниже только если эпизоды менялись
            if (o.progress) cards[k].progress = o.progress;
        }
    }

    _state.log.info({ cards: Object.keys(cards).length }, 'sync: enriching tmdb');
    await enrichCards(cards);

    // Per-show progress fetch — только если эпизоды менялись или у каких-то watched-shows нет progress
    const epChanged = activitiesEpisodesChanged(_state.last_activities, activities);
    const hasMissing = Object.values(cards).some(c =>
        c.type === 'show' && c.in_watched && !c.progress
    );
    if (epChanged || hasMissing || !_state.snapshot) {
        await fetchProgressForWatched(cards, _state.log);
    } else {
        _state.log.info('sync: progress unchanged, skipping per-show fetch');
    }

    // Classify все карточки (movies + shows)
    classifyAll(cards);

    const lists = (raw.lists || []).map(l => ({
        id: l.ids.trakt,
        slug: l.ids.slug,
        name: l.name,
        item_count: l.item_count,
        updated_at: l.updated_at
    }));

    const now = new Date().toISOString();
    const snapshot = {
        meta: {
            generated_at: now,
            full_sync_at: now,
            last_activities: activities,
            items_count: Object.keys(cards).length
        },
        cards,
        lists
    };

    await repo.writeSnapshot(snapshot);
    _state.snapshot = snapshot;
    _state.last_activities = activities;
    _state.lastSyncTookMs = Date.now() - t0;
    _state.log.info({
        items: snapshot.meta.items_count,
        lists: lists.length,
        took_ms: _state.lastSyncTookMs
    }, 'sync: done');
}

export async function syncOnce(force = false) {
    if (_state.syncing) {
        _state.queueAfterSync = true;
        return { skipped: true, reason: 'already syncing' };
    }
    _state.syncing = true;
    try {
        const activities = await trakt.lastActivities();
        const needsMigration = snapshotNeedsMigration(_state.snapshot);
        const changed = force || !_state.snapshot || needsMigration || activitiesChanged(_state.last_activities, activities);
        if (!changed) {
            _state.lastError = null;
            return { skipped: true, reason: 'no changes' };
        }
        if (needsMigration) {
            _state.log.info('snapshot needs migration (missing progress/trakt_status), forcing sync');
        }
        await performSync(activities);
        _state.lastError = null;
        return { ok: true, items: _state.snapshot.meta.items_count, took_ms: _state.lastSyncTookMs };
    } catch (err) {
        _state.lastError = String(err?.message || err);
        _state.log?.error({ err: String(err) }, 'sync failed');
        return { ok: false, error: _state.lastError };
    } finally {
        _state.syncing = false;
        if (_state.queueAfterSync) {
            _state.queueAfterSync = false;
            setTimeout(() => syncOnce().catch(() => {}), 500);
        }
    }
}

// Запускает асинхронный sync с небольшой задержкой. Используется write-actions
// после успешного tap'а — сервер обновит snapshot полностью (TMDB enrich,
// listed_at, etc) пока юзер ещё в sidebar. К моменту следующего захода в
// Activity юзер увидит правильно обогащённую карточку.
export function triggerBackgroundSync(delayMs = 200) {
    setTimeout(() => { syncOnce(true).catch(() => {}); }, delayMs);
}

export function startPolling() {
    if (_state.pollTimer) return;
    _state.pollTimer = setInterval(() => syncOnce().catch(() => {}), POLL_INTERVAL_SEC * 1000);
    _state.log?.info({ interval_sec: POLL_INTERVAL_SEC }, 'poll loop started');
}

export function stopPolling() {
    if (_state.pollTimer) {
        clearInterval(_state.pollTimer);
        _state.pollTimer = null;
    }
}
