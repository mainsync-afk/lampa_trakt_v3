// writeQueue.js — FIFO очередь для write-операций к Trakt.
//
// Зачем: Trakt'овский CF режет burst'ы (Error 1015). Если плагин делает
// несколько быстрых тапов или совпадает с poll-циклом, мы упираемся в 429.
// Решение — выстраивать write'ы в очередь, держать pacing 1.5сек и retry
// с backoff на 429/5xx. Optimistic-обновление snapshot уже произошло до
// enqueue, ошибка Trakt'а откатывает snapshot через `rollback`.
//
// API:
//   writeQueue.init({ log, onSuccess })
//   writeQueue.enqueue({ kind, args, rollback })
//   writeQueue.getStats()
//
// kind: addToWatchlist | removeFromWatchlist | addToHistory | removeFromHistory
//     | addToCollection | removeFromCollection | addToList | removeFromList
// args: { body } или { listId, body } для list-операций.
// rollback(err): async callback вызывается ТОЛЬКО при permanent fail
//   (4xx ≠ 429, либо retries исчерпаны).

import { trakt } from './trakt.js';

// Trakt API лимит на write ≈ 1/сек. Берём 1.5 сек запас.
const PACE_MS = 1500;
// 5 попыток с экспоненциальным backoff. Сумма ожиданий = 77 сек worst-case.
const BACKOFFS_MS = [2000, 5000, 10000, 20000, 40000];

const KIND_FN = {
    addToWatchlist:       (a) => trakt.addToWatchlist(a.body),
    removeFromWatchlist:  (a) => trakt.removeFromWatchlist(a.body),
    addToHistory:         (a) => trakt.addToHistory(a.body),
    removeFromHistory:    (a) => trakt.removeFromHistory(a.body),
    addToCollection:      (a) => trakt.addToCollection(a.body),
    removeFromCollection: (a) => trakt.removeFromCollection(a.body),
    addToList:            (a) => trakt.addToList(a.listId, a.body),
    removeFromList:       (a) => trakt.removeFromList(a.listId, a.body)
};

const _state = {
    queue: [],
    running: false,
    log: null,
    onSuccess: null,
    lastWriteAt: 0,
    nextId: 1
};

export function init({ log, onSuccess }) {
    _state.log = log;
    _state.onSuccess = onSuccess || null;
}

export function enqueue(task) {
    if (!task || !task.kind || !KIND_FN[task.kind]) {
        throw new Error('writeQueue: invalid kind ' + (task && task.kind));
    }
    const item = {
        id: _state.nextId++,
        kind: task.kind,
        args: task.args || {},
        rollback: typeof task.rollback === 'function' ? task.rollback : null,
        attempts: 0,
        enqueued_at: Date.now()
    };
    _state.queue.push(item);
    _state.log?.info({ id: item.id, kind: item.kind, queue_len: _state.queue.length }, 'writeQueue enqueue');
    process.nextTick(tick);
    return item.id;
}

export function getStats() {
    return {
        queue_len: _state.queue.length,
        running: _state.running,
        last_write_at: _state.lastWriteAt ? new Date(_state.lastWriteAt).toISOString() : null
    };
}

function isRateLimited(err) {
    const m = String(err?.message || err);
    return / 429 /.test(m) || /1015/.test(m) || /rate limited/i.test(m);
}
function is5xx(err) {
    const m = String(err?.message || err);
    return / 5\d\d /.test(m);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function tick() {
    if (_state.running) return;
    if (_state.queue.length === 0) return;
    _state.running = true;
    try {
        while (_state.queue.length > 0) {
            const item = _state.queue[0];
            // pacing: не чаще PACE_MS между Trakt-write'ами
            const wait = Math.max(0, _state.lastWriteAt + PACE_MS - Date.now());
            if (wait > 0) await sleep(wait);

            const fn = KIND_FN[item.kind];
            try {
                await fn(item.args);
                _state.lastWriteAt = Date.now();
                _state.queue.shift();
                _state.log?.info({
                    id: item.id, kind: item.kind, attempts: item.attempts + 1,
                    waited_ms: Date.now() - item.enqueued_at
                }, 'writeQueue ok');
                if (_state.onSuccess) {
                    try { _state.onSuccess(item); } catch (_) {}
                }
            } catch (err) {
                item.attempts++;
                _state.lastWriteAt = Date.now();
                const retryable = (isRateLimited(err) || is5xx(err)) && item.attempts < BACKOFFS_MS.length;
                if (retryable) {
                    const delay = BACKOFFS_MS[item.attempts - 1];
                    _state.log?.warn({
                        id: item.id, kind: item.kind, attempts: item.attempts,
                        delay_ms: delay, err: String(err.message || err).slice(0, 200)
                    }, 'writeQueue retry');
                    await sleep(delay);
                    // item остаётся в начале очереди, цикл попробует снова
                } else {
                    _state.log?.error({
                        id: item.id, kind: item.kind, attempts: item.attempts,
                        err: String(err.message || err).slice(0, 200)
                    }, 'writeQueue permanent fail');
                    if (item.rollback) {
                        try { await item.rollback(err); } catch (rbErr) {
                            _state.log?.error({ id: item.id, err: String(rbErr) }, 'writeQueue rollback failed');
                        }
                    }
                    _state.queue.shift();
                }
            }
        }
    } finally {
        _state.running = false;
    }
}

export const writeQueue = { init, enqueue, getStats };
