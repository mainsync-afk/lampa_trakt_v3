// appConfig.js — небольшой персистентный конфиг приложения (в config/app_config.json).
// Сейчас хранит dropped_list_id — id кастомного Trakt-списка, который считается
// «Брошено». Кэшируется в памяти; read-эндпоинты берут синхронно через getConfig().

import { repo } from './repo.js';

let _config = null;

export async function loadConfig() {
    if (_config) return _config;
    _config = (await repo.readAppConfig()) || {};
    return _config;
}

// Синхронный доступ для горячих read-роутов (после loadConfig на старте).
export function getConfig() {
    return _config || {};
}

export function getDroppedListId() {
    const v = getConfig().dropped_list_id;
    return Number.isInteger(v) ? v : null;
}

export async function setDroppedListId(id) {
    const cfg = await loadConfig();
    const n = Number(id);
    cfg.dropped_list_id = Number.isInteger(n) && n > 0 ? n : null;
    _config = cfg;
    await repo.writeAppConfig(cfg);
    return cfg;
}
