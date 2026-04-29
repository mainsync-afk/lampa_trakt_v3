// repo.js — atomic file I/O for snapshot, tmdb cache, auth.
// All writes go via temp+rename to avoid partial files on crash.

import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const CONFIG_DIR = process.env.CONFIG_DIR || '/app/config';

const SNAPSHOT_PATH = path.join(DATA_DIR, 'snapshot.json');
const TMDB_CACHE_PATH = path.join(DATA_DIR, 'tmdb_cache.json');
const AUTH_PATH = path.join(CONFIG_DIR, 'auth.json');

async function readJson(filePath, fallback = null) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') return fallback;
        throw err;
    }
}

async function writeJsonAtomic(filePath, data) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = filePath + '.tmp.' + process.pid;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
}

export const repo = {
    readSnapshot: () => readJson(SNAPSHOT_PATH, null),
    writeSnapshot: (data) => writeJsonAtomic(SNAPSHOT_PATH, data),

    readTmdbCache: () => readJson(TMDB_CACHE_PATH, {}),
    writeTmdbCache: (data) => writeJsonAtomic(TMDB_CACHE_PATH, data),

    readAuth: () => readJson(AUTH_PATH, null),
    writeAuth: (data) => writeJsonAtomic(AUTH_PATH, data),

    paths: {
        snapshot: SNAPSHOT_PATH,
        tmdbCache: TMDB_CACHE_PATH,
        auth: AUTH_PATH
    }
};
