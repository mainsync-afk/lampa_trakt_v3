// actions.js — универсальные toggle-функции над snapshot + Trakt.
// Используется и Lampa-API (routes/tap.js), и в будущем Trakt-compat layer для Showly.
//
// Каждая функция:
//   1. находит/создаёт карточку в snapshot
//   2. optimistic-мутирует флаг
//   3. сохраняет snapshot
//   4. шлёт write на Trakt
//   5. при ошибке откатывает snapshot и пробрасывает исключение

import { trakt } from './trakt.js';
import { repo } from './repo.js';
import { getSnapshot, triggerBackgroundSync } from '../sync/index.js';

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

// Базовый паттерн toggle для boolean-флагов (watchlist/watched/collection).
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

async function toggleBool(tmdb, type, field, addFn, removeFn) {
    const snap = getSnapshot();
    if (!snap) throw new Error('no snapshot yet');

    const card = ensureCardExists(snap, type, tmdb);
    const prev = !!card[field];
    const next = !prev;

    card[field] = next;
    // D1d: если только что отметили watched — удаляем progress_files
    // (карточка считается просмотренной, paused-position больше не нужен).
    if (field === 'in_watched' && next === true) {
        clearProgressForWatched(snap, type, tmdb);
    }
    touchMeta(snap);
    await repo.writeSnapshot(snap);

    try {
        if (next) {
            await addFn(payload(type, tmdb));
        } else {
            await removeFn(payload(type, tmdb));
        }
        // Trakt принял запись → дёргаем full sync в фоне, чтобы snapshot
        // получил полные данные карточки (title, poster, listed_at, ...) без
        // ожидания обычного poll-цикла.
        triggerBackgroundSync(200);
        return { state: cardState(card), action: next ? 'added' : 'removed' };
    } catch (err) {
        // rollback
        card[field] = prev;
        touchMeta(snap);
        await repo.writeSnapshot(snap);
        throw err;
    }
}

export function toggleWatchlist(tmdb, type) {
    return toggleBool(tmdb, type, 'in_watchlist', trakt.addToWatchlist, trakt.removeFromWatchlist);
}

export function toggleWatched(tmdb, type) {
    // Для shows: payload без seasons → Trakt помечает все aired эпизоды как watched_at: now.
    // При remove → Trakt удаляет все наши watched-записи на этом шоу.
    return toggleBool(tmdb, type, 'in_watched', trakt.addToHistory, trakt.removeFromHistory);
}

export function toggleCollection(tmdb, type) {
    return toggleBool(tmdb, type, 'in_collection', trakt.addToCollection, trakt.removeFromCollection);
}

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

    try {
        if (wasIn) {
            await trakt.removeFromList(lid, payload(type, tmdb));
        } else {
            await trakt.addToList(lid, payload(type, tmdb));
        }
        triggerBackgroundSync(200);
        return { state: cardState(card), action: wasIn ? 'removed' : 'added' };
    } catch (err) {
        card.in_lists = prev;
        touchMeta(snap);
        await repo.writeSnapshot(snap);
        throw err;
    }
}
