// classifier.js — гибридный classifier для trakt_status.
//
// Возвращает: 'continue' | 'returning' | 'completed' | null.
//
// Правило для shows:
//   if completed === 0                          → null   (не показываем карточку как watched)
//   if next_episode === null                    → completed (если show ended/canceled), иначе returning
//   if next_episode.first_aired <= now           → continue (есть aired-but-not-watched, надо досмотреть)
//   if next_episode.first_aired > now            → returning (всё что вышло — посмотрено, ждём)
//
// Правило для movies:
//   if in_watched === true                       → completed
//   else                                          → null

function classifyMovie(card) {
    return card.in_watched ? 'completed' : null;
}

function classifyShow(card) {
    const p = card.progress;
    if (!p || !p.completed) return null;

    if (!p.next_aired_at) {
        // next_episode === null → дошёл до последнего aired (или дальше нечего)
        const s = String(card.show_status || '').toLowerCase();
        if (s === 'ended' || s === 'canceled') return 'completed';
        return 'returning';
    }

    // next_episode существует, проверяем дату его выхода
    const nextMs = Date.parse(p.next_aired_at);
    if (Number.isFinite(nextMs) && nextMs > Date.now()) {
        // следующий эпизод ещё не вышел — пользователь дошёл до конца aired
        return 'returning';
    }
    // следующий уже aired — есть что досмотреть
    return 'continue';
}

export function classifyCard(card) {
    if (card.type === 'movie') return classifyMovie(card);
    return classifyShow(card);
}

export function classifyAll(cards) {
    for (const c of Object.values(cards)) {
        c.trakt_status = classifyCard(c);
    }
}
