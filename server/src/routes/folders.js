// folders.js — основной read-эндпоинт для клиента.
// Маппит универсальную карточку в Lampa-совместимый формат
// (см. v2 trakt_v2.js: formatMedia + enrichWithTmdb).

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

        // membership-флаги (Trakt 1:1)
        trakt: {
            in_watchlist: !!c.in_watchlist,
            in_watched: !!c.in_watched,
            in_collection: !!c.in_collection,
            in_lists: c.in_lists || []
        }
    };
    if (c.type === 'show') {
        card.name = c.title;
        card.original_name = c.original_title;
        if (c.number_of_seasons) card.number_of_seasons = c.number_of_seasons;
    }
    return card;
}

const EMPTY_RESPONSE = {
    generated_at: null,
    folders: [
        { id: 'watchlist',      title: 'Watchlist',       count: 0, items: [] },
        { id: 'watched_movies', title: 'Watched Movies',  count: 0, items: [] },
        { id: 'watched_shows',  title: 'Watched Shows',   count: 0, items: [] },
        { id: 'collection',     title: 'Collection',      count: 0, items: [] }
    ],
    custom_lists: []
};

export default async function (app) {
    app.get('/api/folders', async () => {
        const snap = getSnapshot();
        if (!snap) return EMPTY_RESPONSE;

        const cards = Object.values(snap.cards || {});
        const wl  = cards.filter(c => c.in_watchlist).map(toLampaCard);
        const wm  = cards.filter(c => c.in_watched && c.type === 'movie').map(toLampaCard);
        const ws  = cards.filter(c => c.in_watched && c.type === 'show').map(toLampaCard);
        const col = cards.filter(c => c.in_collection).map(toLampaCard);

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
            folders: [
                { id: 'watchlist',      title: 'Watchlist',      count: wl.length,  items: wl  },
                { id: 'watched_movies', title: 'Watched Movies', count: wm.length,  items: wm  },
                { id: 'watched_shows',  title: 'Watched Shows',  count: ws.length,  items: ws  },
                { id: 'collection',     title: 'Collection',     count: col.length, items: col }
            ],
            custom_lists: custom
        };
    });
}
