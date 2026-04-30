// folders.js — основной read-эндпоинт для клиента.
// Маппит универсальную карточку в Lampa-совместимый формат.
// 4 ряда: Смотрю / Закладки / Продолжение следует / Просмотрено.
// Сортировка внутри ряда (DESC, новое слева):
//   - watchlist: по listed_at
//   - continue/returning/completed: по progress.last_watched_at (для shows)
//                                  или last_watched_at (для movies)
//   - custom lists: по list_listed_at[listId]

import { getSnapshot } from '../sync/index.js';
import { tmdb } from '../lib/tmdb.js';

function tsOf(s) {
    if (!s) return 0;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
}

function watchedAtOf(c) {
    // Для shows предпочитаем progress.last_watched_at (точнее), fallback к last_watched_at
    if (c.type === 'show' && c.progress && c.progress.last_watched_at) {
        return tsOf(c.progress.last_watched_at);
    }
    return tsOf(c.last_watched_at);
}

// Дата выхода следующего эпизода (для Returning — ближайший новый сезон/серия).
function nextAiredAtOf(c) {
    if (c.type === 'show' && c.progress && c.progress.next_aired_at) {
        return tsOf(c.progress.next_aired_at);
    }
    return 0;
}

function sortByDesc(items, getter) {
    return items.slice().sort((a, b) => getter(b) - getter(a));
}

// Ascending sort, но карточки без даты (getter===0) уезжают в конец.
function sortByAsc(items, getter) {
    return items.slice().sort((a, b) => {
        const av = getter(a);
        const bv = getter(b);
        if (av === 0 && bv === 0) return 0;
        if (av === 0) return 1;
        if (bv === 0) return -1;
        return av - bv;
    });
}

function toLampaCard(c) {
    const method = c.type === 'movie' ? 'movie' : 'tv';
    const poster = tmdb.posterUrl(c.poster_path, 'w300');
    const card = {
        // Lampa identity
        id: c.tmdb,
        ids: { tmdb: c.tmdb, trakt: c.trakt_id, imdb: c.imdb_id || undefined },
        method,
        card_type: method,
        component: 'full',
        source: 'tmdb',

        // Lampa display
        title: c.title,
        original_title: c.original_title,
        release_date: c.release_date,
        vote_average: c.vote_average,
        poster_path: c.poster_path,
        poster: poster,
        img: poster,

        // membership-флаги + computed status
        trakt: {
            in_watchlist: !!c.in_watchlist,
            in_watched: !!c.in_watched,
            in_collection: !!c.in_collection,
            in_lists: c.in_lists || [],
            status: c.trakt_status || null   // 'continue' | 'returning' | 'completed' | null
        }
    };
    if (c.type === 'show') {
        card.name = c.title;
        card.original_name = c.original_title;
        if (c.number_of_seasons) card.number_of_seasons = c.number_of_seasons;
    }
    return card;
}

const FOLDERS = [
    // Continue Watching: что досматривать сейчас → свежее по последнему просмотру слева.
    { id: 'continue_watching', title: 'Смотрю',              filter: c => c.trakt_status === 'continue',  sortBy: watchedAtOf,    dir: 'desc' },
    // Watchlist: orthogonal-тег → свежее добавление слева.
    { id: 'watchlist',         title: 'Закладки',            filter: c => c.in_watchlist,                  sortBy: c => tsOf(c.listed_at), dir: 'desc' },
    // Returning: дошёл до конца, ждём → ближайший новый эпизод/сезон вверху.
    { id: 'returning',         title: 'Продолжение следует', filter: c => c.trakt_status === 'returning',  sortBy: nextAiredAtOf,  dir: 'asc'  },
    // Completed: закрыто и досмотрено → последнее досмотренное вверху.
    { id: 'completed',         title: 'Просмотрено',         filter: c => c.trakt_status === 'completed',  sortBy: watchedAtOf,    dir: 'desc' }
];

const EMPTY_RESPONSE = {
    generated_at: null,
    folders: FOLDERS.map(f => ({ id: f.id, title: f.title, count: 0, items: [] })),
    custom_lists: []
};

export default async function (app) {
    app.get('/api/folders', async () => {
        const snap = getSnapshot();
        if (!snap) return EMPTY_RESPONSE;

        const cards = Object.values(snap.cards || {});

        const folders = FOLDERS.map(f => {
            const filtered = cards.filter(f.filter);
            const sorted = (f.dir === 'asc')
                ? sortByAsc(filtered, f.sortBy)
                : sortByDesc(filtered, f.sortBy);
            const items = sorted.map(toLampaCard);
            return { id: f.id, title: f.title, count: items.length, items };
        });

        const lists = snap.lists || [];
        const custom = lists.map(l => {
            const filtered = cards.filter(c => (c.in_lists || []).includes(l.id));
            const sorted = sortByDesc(filtered, c => tsOf((c.list_listed_at || {})[l.id]));
            const items = sorted.map(toLampaCard);
            return {
                id: l.id,
                slug: l.slug,
                title: l.name,
                count: items.length,
                items
            };
        });

        return {
            generated_at: snap.meta?.generated_at || null,
            folders,
            custom_lists: custom
        };
    });
}
