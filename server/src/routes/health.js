import { getStatus } from '../sync/index.js';

export default async function (app) {
    app.get('/api/health', async () => ({
        ok: true,
        version: app.appVersion || 'unknown',
        ts: new Date().toISOString(),
        uptime_s: Math.round(process.uptime()),
        sync: getStatus()
    }));
}
