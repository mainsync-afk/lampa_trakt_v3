// dropIntents.js — окно-намерение для drop/undrop.
//
// При действии пользователя (тап «Брошено») фиксируем НАМЕРЕНИЕ (dropped|нет) по
// шоу на короткий срок. Reconciler в синке доверяет намерению, а не наполовину
// просочившемуся чтению Trakt — иначе на лаге Trakt undrop «воскрешает» брошенное.
// По истечении окна (или когда Trakt подтвердил оба хранилища) намерение снимается.

const INTENT_TTL_MS = 180000; // 3 минуты — запас на пропагацию Trakt

const _intents = new Map(); // key 'show:<tmdb>' → { dropped: boolean, expires: ms }

export function setDropIntent(key, dropped) {
    _intents.set(key, { dropped: !!dropped, expires: Date.now() + INTENT_TTL_MS });
}

// Возвращает boolean (намерение) или null, если намерения нет/истекло.
export function getDropIntent(key) {
    const i = _intents.get(key);
    if (!i) return null;
    if (Date.now() > i.expires) { _intents.delete(key); return null; }
    return i.dropped;
}

export function clearDropIntent(key) {
    _intents.delete(key);
}
