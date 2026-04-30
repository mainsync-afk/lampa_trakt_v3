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
                show_status: type === 'show' ? null : undefined,    // 'returning series' | 'ended' | 'canceled' | 'in production'
                aired_episodes: type === 'show' ? null : undefined,
                progress: null,                                      // {completed, aired, next_aired_at, last_watched_at}
                trakt_status: null,                                  // 'continue' | 'returning' | 'completed' | null
                in_watchlist: false,
                in_watched: false,
                in_collection: false,
                in_lists: [],
                // Для сортировки: даты добавления/просмотра.
                listed_at: null,                                     // когда добавлено в Watchlist
                last_watched_at: null,                               // когда последний раз смотрели (history)
                collected_at: null,                                  // когда добавлено в Collection
                list_listed_at: {}                                   // по custom-list: { listId: ISO }
            };
        }
        // show_status / aired_episodes могут меняться между sync — обновляем всегда
        if (type === 'show') {
            if (media.status) cards[k].show_status = media.status;
            if (typeof media.aired_episodes === 'number') cards[k].aired_episodes = media.aired_episodes;
        }
        return cards[k];
    }

    // watchlist (entry: { type, listed_at, movie/show })
    (raw.watchlistMovies || []).forEach(it => {
        const c = ensureCard('movie', it.movie);
        if (c) { c.in_watchlist = true; if (it.listed_at) c.listed_at = it.listed_at; }
    });
    (raw.watchlistShows || []).forEach(it => {
        const c = ensureCard('show', it.show);
        if (c) { c.in_watchlist = true; if (it.listed_at) c.listed_at = it.listed_at; }
    });

    // watched (entry: { plays, last_watched_at, movie/show, seasons[] })
    (raw.watchedMovies || []).forEach(it => {
        const c = ensureCard('movie', it.movie);
        if (c) { c.in_watched = true; if (it.last_watched_at) c.last_watched_at = it.last_watched_at; }
    });
    (raw.watchedShows || []).forEach(it => {
        const c = ensureCard('show', it.show);
        if (c) { c.in_watched = true; if (it.last_watched_at) c.last_watched_at = it.last_watched_at; }
    });

    // collection (entry: { last_collected_at, movie/show })
    (raw.collectionMovies || []).forEach(it => {
        const c = ensureCard('movie', it.movie);
        if (c) { c.in_collection = true; if (it.last_collected_at) c.collected_at = it.last_collected_at; }
    });
    (raw.collectionShows || []).forEach(it => {
        const c = ensureCard('show', it.show);
        if (c) { c.in_collection = true; if (it.last_collected_at) c.collected_at = it.last_collected_at; }
    });

    // custom lists (raw.listItems = { [listId]: [items] })
    Object.entries(raw.listItems || {}).forEach(([listIdStr, items]) => {
        const listId = Number(listIdStr);
        (items || []).forEach(it => {
            const type = it.type;
            if (type !== 'movie' && type !== 'show') return;
            const media = it[type];
            const c = ensureCard(type, media);
            if (c) {
                if (!c.in_lists.includes(listId)) c.in_lists.push(listId);
                if (it.listed_at) c.list_listed_at[listId] = it.listed_at;
            }
        });
    });

    return cards;
}
