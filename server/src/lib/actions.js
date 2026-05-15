// actions.js — универсальные toggle-функции над snapshot + writeQueue.
// Используется и Lampa-API (routes/tap.js), и в будущем Trakt-compat layer для Showly.
//
// Поведение (с v0.5.0):
//   1. ensure card + optimistic-мутируем флаг
//   2. writeSnapshot
//   3. enqueue в writeQueue (FIFO, pacing 1.5сек, retry 5x backoff)
//   4. return optimistic-state СРАЗУ (без ожидания Trakt)
//   5. при permanent fail Trakt'а — rollback через callback writeQueue

import { writeQueue } from './writeQueue.js';
import { repo } from './repo.js';
import { getSnapshot } from '../sync/index.js';

function key(type, tmdb) { return type + ':' + tmdb; }

function ensureCardExists(snap, type, tmdb) {
    const k = key(type, tmdb);
    if (!snap.cards[k]) {
        snap.cards[k] = {
            tmdb,
            type,
            trakt_id: null,
            imdb_id: null,
            title: '',
            original_title: '',
            year: null,
            release_date: '',
            poster_path: null,
            vote_average: 0,
            number_of_seasons: type === 'show' ? null : undefined,
            in_watchlist: false,
            in_watched: false,
            in_collection: false,
            in_lists: []
        };
    }
    return snap.cards[k];
}

function payload(type, tmdb) {
    const item = { ids: { tmdb } };
    return type === 'movie' ? { movies: [item] } : { shows: [item] };
}

function cardState(card) {
    return {
        in_watchlist:  !!card.in_watchlist,
        in_watched:    !!card.in_watched,
        in_collection: !!card.in_collection,
        in_lists:      card.in_lists || []
    };
}

function touchMeta(snap) {
    snap.meta.generated_at = new Date().toISOString();
}

function clearProgressForWatched(snap, type, tmdb) {
    if (!snap.progress_files) return;
    if (type === 'movie') {
        delete snap.progress_files['movie:' + tmdb];
    } else if (type === 'show') {
        const prefix = 'show:' + tmdb + ':';
        for (const k of Object.keys(snap.progress_files)) {
            if (k.startsWith(prefix)) delete snap.progress_files[k];
        }
    }
}

// Откат флага карточки при permanent fail Trakt'а. Делается ассинхронно
// из writeQueue, поэтому читаем актуальный snapshot заново.
async function rollbackFieldFlag(type, tmdb, field, prevValue) {
    const snap = getSnapshot();
    if (!snap || !snap.cards) return;
    const k = key(type, tmdb);
    const card = snap.cards[k];
    if (!card) return;
    card[field] = prevValue;
    touchMeta(snap);
    await repo.writeSnapshot(snap);
}

async function rollbackList(type, tmdb, prevInLists) {
    const snap = getSnapshot();
    if (!snap || !snap.cards) return;
    const k = key(type, tmdb);
    const card = snap.cards[k];
    if (!card) return;
    card.in_lists = prevInLists;
    touchMeta(snap);
    await repo.writeSnapshot(snap);
}

const KIND_FOR_FIELD = {
    in_watchlist:  { add: 'addToWatchlist',  remove: 'removeFromWatchlist'  },
    in_watched:    { add: 'addToHistory',    remove: 'removeFromHistory'    },
    in_collection: { add: 'addToCollection', remove: 'removeFromCollection' }
};

async function toggleBool(tmdb, type, field) {
    const snap = getSnapshot();
    if (!snap) throw new Error('no snapshot yet');

    const card = ensureCardExists(snap, type, tmdb);
    const prev = !!card[field];
    const next = !prev;

    card[field] = next;
    if (field === 'in_watched' && next === true) {
        clearProgressForWatched(snap, type, tmdb);
    }
    touchMeta(snap);
    await repo.writeSnapshot(snap);

    const kinds = KIND_FOR_FIELD[field];
    writeQueue.enqueue({
        kind: next ? kinds.add : kinds.remove,
        args: { body: payload(type, tmdb) },
        rollback: async () => rollbackFieldFlag(type, tmdb, field, prev)
    });
    return { state: cardState(card), action: next ? 'added' : 'removed' };
}

export function toggleWatchlist(tmdb, type)  { return toggleBool(tmdb, type, 'in_watchlist'); }
export function toggleWatched(tmdb, type)    { return toggleBool(tmdb, type, 'in_watched'); }
export function toggleCollection(tmdb, type) { return toggleBool(tmdb, type, 'in_collection'); }

export async function toggleListMembership(tmdb, type, listId) {
    const snap = getSnapshot();
    if (!snap) throw new Error('no snapshot yet');

    const lid = Number(listId);
    if (!Number.isInteger(lid) || lid <= 0) throw new Error('invalid listId');

    const card = ensureCardExists(snap, type, tmdb);
    const inLists = Array.isArray(card.in_lists) ? card.in_lists : [];
    const wasIn = inLists.includes(lid);
    const prev = [...inLists];
    const next = wasIn ? inLists.filter(x => x !== lid) : [...inLists, lid];

    card.in_lists = next;
    touchMeta(snap);
    await repo.writeSnapshot(snap);

    writeQueue.enqueue({
        kind: wasIn ? 'removeFromList' : 'addToList',
        args: { listId: lid, body: payload(type, tmdb) },
        rollback: async () => rollbackList(type, tmdb, prev)
    });
    return { state: cardState(card), action: wasIn ? 'removed' : 'added' };
}
