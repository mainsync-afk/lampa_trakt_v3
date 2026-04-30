// folders.js — основной read-эндпоинт для клиента.
// Маппит универсальную карточку в Lampa-совместимый формат.
// 4 ряда: Смотрю / Закладки / Продолжение следует / Просмотрено.

import { getSnapshot } from '../sync/index.js';
import { tmdb } from '../lib/tmdb.js';

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
    { id: 'continue_watching', title: 'Смотрю',              filter: c => c.trakt_status === 'continue' },
    { id: 'watchlist',         title: 'Закладки',            filter: c => c.in_watchlist },
    { id: 'returning',         title: 'Продолжение следует', filter: c => c.trakt_status === 'returning' },
    { id: 'completed',         title: 'Просмотрено',         filter: c => c.trakt_status === 'completed' }
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
            const items = cards.filter(f.filter).map(toLampaCard);
            return { id: f.id, title: f.title, count: items.length, items };
        });

        const lists = snap.lists || [];
        const custom = lists.map(l => {
            const items = cards.filter(c => (c.in_lists || []).includes(l.id)).map(toLampaCard);
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
