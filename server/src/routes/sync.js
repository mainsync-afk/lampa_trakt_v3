// sync.js routes — статус и форс-ресинк.

import { syncOnce, getStatus } from '../sync/index.js';

export default async function (app) {
    app.get('/api/sync/status', async () => getStatus());

    app.post('/api/sync/force', async () => {
        const result = await syncOnce(true);
        return { ...result, status: getStatus() };
    });
}
