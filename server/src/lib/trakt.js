// trakt.js — Trakt API client с auto-refresh access_token.
// Public API: trakt.lastActivities(), trakt.watchlist(type), trakt.watched(type),
//             trakt.collection(type), trakt.lists(), trakt.listItems(id),
//             trakt.fetch(path, opts) — низкоуровневый доступ для write API.

import { repo } from './repo.js';

const TRAKT_BASE = 'https://api.trakt.tv';
const CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;
const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // refresh за день до истечения

let _auth = null;
let _refreshPromise = null;

async function getAuth() {
    if (!_auth) _auth = await repo.readAuth();
    return _auth;
}

async function refreshToken() {
    if (_refreshPromise) return _refreshPromise;
    _refreshPromise = (async () => {
        const auth = await getAuth();
        if (!auth || !auth.refresh_token) {
            throw new Error('No refresh_token; run scripts/trakt-auth.js first');
        }
        const res = await fetch(TRAKT_BASE + '/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                refresh_token: auth.refresh_token,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
                grant_type: 'refresh_token'
            })
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error('Trakt refresh failed: ' + res.status + ' ' + text);
        }
        const data = await res.json();
        const fresh = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            token_type: data.token_type,
            scope: data.scope,
            expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
            created_at: new Date().toISOString()
        };
        await repo.writeAuth(fresh);
        _auth = fresh;
        return fresh;
    })();
    try {
        return await _refreshPromise;
    } finally {
        _refreshPromise = null;
    }
}

async function ensureFreshAuth() {
    let auth = await getAuth();
    if (!auth) throw new Error('No auth.json; run scripts/trakt-auth.js first');
    const expiresAt = Date.parse(auth.expires_at || 0);
    if (!expiresAt || expiresAt - Date.now() < REFRESH_THRESHOLD_MS) {
        auth = await refreshToken();
    }
    return auth;
}

async function traktFetch(pathPart, opts = {}) {
    const auth = await ensureFreshAuth();
    const url = TRAKT_BASE + pathPart;
    const headers = {
        'Authorization': 'Bearer ' + auth.access_token,
        'trakt-api-version': '2',
        'trakt-api-key': CLIENT_ID,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
    };
    let res = await fetch(url, { ...opts, headers });
    if (res.status === 401) {
        // token внезапно стал невалидным — форсируем refresh и повторяем
        const fresh = await refreshToken();
        headers['Authorization'] = 'Bearer ' + fresh.access_token;
        res = await fetch(url, { ...opts, headers });
    }
    return res;
}

async function getJson(pathPart, opts = {}) {
    const r = await traktFetch(pathPart, opts);
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error('Trakt ' + pathPart + ' -> ' + r.status + ' ' + body.slice(0, 200));
    }
    return r.json();
}

export const trakt = {
    fetch: traktFetch,

    lastActivities: () => getJson('/sync/last_activities'),

    watchlist: (type) => getJson(`/sync/watchlist/${type}?extended=full`),
    watched: (type) => getJson(`/sync/watched/${type}?extended=full`),
    collection: (type) => getJson(`/sync/collection/${type}?extended=full`),

    lists: () => getJson('/users/me/lists'),
    listItems: (listId) => getJson(`/users/me/lists/${listId}/items?type=show,movie&limit=2000&extended=full`)
};

export { ensureFreshAuth, refreshToken };
