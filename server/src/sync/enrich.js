// enrich.js — TMDB enrichment поверх cards-dict.
// Заполняет poster_path, vote_average, локализованные title/release_date,
// number_of_seasons (для shows). Без TMDB-data карточка остаётся валидной (graceful).

import { tmdb } from '../lib/tmdb.js';

export async function enrichCards(cards) {
    const targets = Object.values(cards).map(c => ({ type: c.type, tmdb: c.tmdb }));
    if (targets.length === 0) return cards;
    const enriched = await tmdb.enrichMany(targets);

    for (const c of Object.values(cards)) {
        const data = enriched[c.type + ':' + c.tmdb];
        if (!data) continue;
        if (data.poster_path) c.poster_path = data.poster_path;
        if (typeof data.vote_average === 'number') c.vote_average = Number(data.vote_average.toFixed(1));
        if (c.type === 'movie') {
            if (data.title) c.title = data.title;
            if (data.original_title) c.original_title = data.original_title;
            if (data.release_date) c.release_date = data.release_date;
        } else {
            if (data.name) c.title = data.name;
            if (data.original_name) c.original_title = data.original_name;
            if (data.first_air_date) c.release_date = data.first_air_date;
            if (typeof data.number_of_seasons === 'number') c.number_of_seasons = data.number_of_seasons;
        }
    }
    return cards;
}
