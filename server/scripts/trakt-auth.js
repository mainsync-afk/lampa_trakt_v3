#!/usr/bin/env node
// Trakt OAuth device-code flow.
// Запуск: docker compose exec server node scripts/trakt-auth.js
// Сохраняет access_token + refresh_token в /app/config/auth.json (volume).
// После первого получения сервер сам обновляет токены.

import { repo } from '../src/lib/repo.js';

const TRAKT_BASE = 'https://api.trakt.tv';
const CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Set TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET in .env');
    process.exit(1);
}

async function deviceCode() {
    const r = await fetch(TRAKT_BASE + '/oauth/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID })
    });
    if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error('device/code: ' + r.status + ' ' + text);
    }
    return r.json();
}

async function pollToken(code) {
    const r = await fetch(TRAKT_BASE + '/oauth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET
        })
    });
    if (r.status === 200) return r.json();
    if (r.status === 400) return null;             // pending — продолжаем поллинг
    if (r.status === 404) throw new Error('Device code not found / expired');
    if (r.status === 409) throw new Error('Already used');
    if (r.status === 410) throw new Error('Device code expired');
    if (r.status === 418) throw new Error('Denied by user');
    if (r.status === 429) throw new Error('Slow down');
    const text = await r.text().catch(() => '');
    throw new Error('Unexpected: ' + r.status + ' ' + text);
}

async function main() {
    console.log('Requesting device code from Trakt...');
    const dc = await deviceCode();
    console.log('');
    console.log('==================================================');
    console.log('  Open in browser: ' + dc.verification_url);
    console.log('  Enter code:      ' + dc.user_code);
    console.log('==================================================');
    console.log('');
    console.log('Code expires in ' + dc.expires_in + ' seconds.');
    console.log('Polling every ' + dc.interval + ' seconds...');
    console.log('');

    const deadline = Date.now() + dc.expires_in * 1000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, dc.interval * 1000));
        const t = await pollToken(dc.device_code);
        if (t) {
            const auth = {
                access_token: t.access_token,
                refresh_token: t.refresh_token,
                token_type: t.token_type,
                scope: t.scope,
                expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
                created_at: new Date().toISOString()
            };
            await repo.writeAuth(auth);
            console.log('Success. Token saved.');
            console.log('  expires_at:   ' + auth.expires_at);
            console.log('  scope:        ' + auth.scope);
            console.log('');
            console.log('Restart server: docker compose restart server');
            process.exit(0);
        }
        process.stdout.write('.');
    }
    console.error('\nDevice code expired without authorization.');
    process.exit(1);
}

main().catch(err => {
    console.error('\nError:', err.message || err);
    process.exit(1);
});
