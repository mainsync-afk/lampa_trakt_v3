// tap.js — Lampa-API write endpoints. Тонкая обёртка над lib/actions.js.
// Все эндпоинты принимают POST с JSON-body { tmdb, type }, выполняют toggle,
// возвращают новое состояние карточки.

import * as actions from '../lib/actions.js';

const VALID_TYPES = new Set(['movie', 'show']);

class HttpError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.statusCode = statusCode;
    }
}

function parseBody(body) {
    const tmdb = Number(body?.tmdb);
    const type = String(body?.type || '');
    if (!Number.isInteger(tmdb) || tmdb <= 0) {
        throw new HttpError('invalid tmdb (must be positive integer)', 400);
    }
    if (!VALID_TYPES.has(type)) {
        throw new HttpError('invalid type (must be "movie" or "show")', 400);
    }
    return { tmdb, type };
}

function send(reply, fn) {
    return Promise.resolve()
        .then(fn)
        .then(result => ({ ok: true, ...result }))
        .catch(err => {
            const code = err.statusCode || 500;
            reply.log?.warn({ err: String(err.message || err) }, 'tap failed');
            return reply.code(code).send({
                ok: false,
                error: String(err.message || err)
            });
        });
}

export default async function (app) {
    app.post('/api/tap/watchlist', async (req, reply) => send(reply, () => {
        const { tmdb, type } = parseBody(req.body);
        return actions.toggleWatchlist(tmdb, type);
    }));

    app.post('/api/tap/watched', async (req, reply) => send(reply, () => {
        const { tmdb, type } = parseBody(req.body);
        return actions.toggleWatched(tmdb, type);
    }));

    app.post('/api/tap/collection', async (req, reply) => send(reply, () => {
        const { tmdb, type } = parseBody(req.body);
        return actions.toggleCollection(tmdb, type);
    }));

    app.post('/api/tap/list/:listId', async (req, reply) => send(reply, () => {
        const { tmdb, type } = parseBody(req.body);
        const listId = Number(req.params.listId);
        if (!Number.isInteger(listId) || listId <= 0) {
            throw new HttpError('invalid listId', 400);
        }
        return actions.toggleListMembership(tmdb, type, listId);
    }));
}
