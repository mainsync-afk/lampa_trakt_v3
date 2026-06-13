// config.js — чтение/запись клиентских настроек приложения.
// Сейчас: dropped_list_id (какой кастомный список = «Брошено»).

import { loadConfig, setDroppedListId } from '../lib/appConfig.js';

export default async function (app) {
    app.get('/api/config', async () => {
        const cfg = await loadConfig();
        return { ok: true, dropped_list_id: cfg.dropped_list_id ?? null };
    });

    app.post('/api/config', async (req, reply) => {
        const id = req.body?.dropped_list_id;
        if (id !== null && id !== undefined && !(Number.isInteger(Number(id)) && Number(id) > 0)) {
            return reply.code(400).send({ ok: false, error: 'invalid dropped_list_id' });
        }
        const cfg = await setDroppedListId(id);
        return { ok: true, dropped_list_id: cfg.dropped_list_id ?? null };
    });
}
