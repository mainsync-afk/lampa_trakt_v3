// normalize.js — Trakt-ответы → плоский cards-dict.
// Ключ карточки: '<type>:<tmdb>'. type ∈ 'movie' | 'show'.

export function normalizeTraktSnapshot(raw) {
    const cards = {};

    function ensureCard(type, media) {
        if (!media || !media.ids || !media.ids.tmdb) return null;
        const k = type + ':' + media.ids.tmdb;
        if (!cards[k]) {
            const year = media.year || null;
            cards[k] = {
                tmdb: media.ids.tmdb,
                type, // 'movie' | 'show'
                trakt_id: media.ids.trakt || null,
                imdb_id: media.ids.imdb || null,
                title: media.title || '',
                original_title: media.title || '',
                year,
                release_date: media.released || (year ? year + '-01-01' : ''),
                poster_path: null,
                vote_average: 0,
                number_of_seasons: type === 'show' ? null : undefined,
                in_watchlist: false,
                in_watched: false,
                in_collection: false,
                in_lists: []
            };
        }
        return cards[k];
    }

    // watchlist (entry: { type, listed_at, movie/show })
    (raw.watchlistMovies || []).forEach(it => {
        const c = ensureCard('movie', it.movie);
        if (c) c.in_watchlist = true;
    });
    (raw.watchlistShows || []).forEach(it => {
        const c = ensureCard('show', it.show);
        if (c) c.in_watchlist = true;
    });

    // watched (entry: { plays, last_watched_at, movie/show, seasons[] })
    (raw.watchedMovies || []).forEach(it => {
        const c = ensureCard('movie', it.movie);
        if (c) c.in_watched = true;
    });
    (raw.watchedShows || []).forEach(it => {
        const c = ensureCard('show', it.show);
        if (c) c.in_watched = true;
    });

    // collection (entry: { last_collected_at, movie/show })
    (raw.collectionMovies || []).forEach(it => {
        const c = ensureCard('movie', it.movie);
        if (c) c.in_collection = true;
    });
    (raw.collectionShows || []).forEach(it => {
        const c = ensureCard('show', it.show);
        if (c) c.in_collection = true;
    });

    // custom lists (raw.listItems = { [listId]: [items] })
    Object.entries(raw.listItems || {}).forEach(([listIdStr, items]) => {
        const listId = Number(listIdStr);
        (items || []).forEach(it => {
            const type = it.type;
            if (type !== 'movie' && type !== 'show') return;
            const media = it[type];
            const c = ensureCard(type, media);
            if (c && !c.in_lists.includes(listId)) c.in_lists.push(listId);
        });
    });

    return cards;
}
