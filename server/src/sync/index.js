// sync/index.js — главный sync-engine.
// Стратегия: poll /sync/last_activities каждые SYNC_POLL_INTERVAL_SEC секунд.
// При изменении любых таймстампов — полный re-fetch всех Trakt-секций
// (8-15 запросов, дешевле и проще, чем точечный sync).
// TMDB enrich только для карточек, отсутствующих в кеше или с истёкшим TTL.

import { trakt } from '../lib/trakt.js';
import { repo } from '../lib/repo.js';
import { normalizeTraktSnapshot } from './normalize.js';
import { enrichCards } from './enrich.js';

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

async function performSync(activities) {
    const t0 = Date.now();
    _state.log.info('sync: fetching trakt');
    const raw = await fetchAll();

    _state.log.info('sync: normalizing');
    const cards = normalizeTraktSnapshot(raw);

    // Carryover display-полей из старого snapshot чтобы новые карточки могли
    // получить TMDB-обогащение, а уже обогащённые — пропустить дёрганье TMDB.
    if (_state.snapshot && _state.snapshot.cards) {
        const old = _state.snapshot.cards;
        for (const k of Object.keys(cards)) {
            if (old[k] && old[k].poster_path) {
                cards[k].poster_path = old[k].poster_path;
                cards[k].vote_average = old[k].vote_average;
                cards[k].title = old[k].title || cards[k].title;
                cards[k].original_title = old[k].original_title || cards[k].original_title;
                cards[k].release_date = old[k].release_date || cards[k].release_date;
                if (cards[k].type === 'show') {
                    cards[k].number_of_seasons = old[k].number_of_seasons || cards[k].number_of_seasons;
                }
            }
        }
    }

    _state.log.info({ cards: Object.keys(cards).length }, 'sync: enriching tmdb');
    await enrichCards(cards);

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
        const changed = force || !_state.snapshot || activitiesChanged(_state.last_activities, activities);
        if (!changed) {
            _state.lastError = null;
            return { skipped: true, reason: 'no changes' };
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
