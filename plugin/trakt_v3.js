/*!
 * trakt_v3.js — Lampa-Trakt Plugin v3
 *
 * Тонкий клиент над собственным VPS-прокси (lampa_trakt_v3-server).
 * Сервер делает OAuth, sync, classifier, TMDB-обогащение, write-actions.
 * Плагин — UI: 4 ряда (Смотрю/Закладки/Продолжение следует/Просмотрено)
 * + sidebar на тапе карточки (toggle Watchlist/Completed + индикаторы CW/Returning
 * + по строке на каждый custom-list).
 *
 * Сервер по умолчанию: https://trakt.fastcdn.pics
 * Меняется в Lampa Settings → Trakt v3 → Сервер.
 *
 * Зависимости:
 *  - Lampa runtime (Lampa.Component, Lampa.Manifest, Lampa.SettingsApi, Lampa.Select, Lampa.Noty,
 *    Lampa.Activity, Lampa.Lang, Lampa.Storage, Lampa.Scroll, Lampa.InteractionLine, Lampa.Controller)
 */
(function () {
    'use strict';

    var VERSION = '0.1.18';
    try { console.log('[trakt_v3] file loaded, version ' + VERSION); } catch (_) {}

    // ────────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────────
    var COMPONENT = 'trakt_v3_main';
    var SETTINGS_COMPONENT = 'trakt_v3';
    var MENU_DATA_ATTR = 'trakt_v3_menu';

    var DEFAULT_SERVER_URL = 'https://trakt.fastcdn.pics';
    var STORAGE_SERVER_URL = 'trakt_v3_server_url';
    var STORAGE_FOLDERS_CACHE = 'trakt_v3_folders_cache';

    // 4 фиксированных пункта sidebar.
    // isToggle=true → tap делает POST к серверу.
    // isToggle=false → индикатор (показывает текущий status, на тап не реагирует).
    var SIDEBAR_FIXED = [
        { action: 'watchlist', name: 'Закладки',            isToggle: true,  endpoint: '/api/tap/watchlist', notifyAdded: 'Закладки: добавлено',     notifyRemoved: 'Закладки: убрано' },
        { action: 'continue',  name: 'Смотрю',              isToggle: false, separatorBefore: true },
        { action: 'returning', name: 'Продолжение следует', isToggle: false },
        { action: 'completed', name: 'Просмотрено',         isToggle: true,  endpoint: '/api/tap/watched',   notifyAdded: 'Просмотрено: отмечено',   notifyRemoved: 'Просмотрено: снято' }
    ];

    // ────────────────────────────────────────────────────────────────────
    // Storage helpers
    // ────────────────────────────────────────────────────────────────────
    function getServerUrl() {
        try {
            var v = String(Lampa.Storage.get(STORAGE_SERVER_URL, '') || '').trim();
            return v || DEFAULT_SERVER_URL;
        } catch (_) { return DEFAULT_SERVER_URL; }
    }

    function setServerUrl(url) {
        try { Lampa.Storage.set(STORAGE_SERVER_URL, String(url || '').trim()); } catch (_) {}
    }

    function readCachedFolders() {
        try {
            var raw = Lampa.Storage.get(STORAGE_FOLDERS_CACHE, '');
            if (!raw) return null;
            return (typeof raw === 'string') ? JSON.parse(raw) : raw;
        } catch (_) { return null; }
    }

    function writeCachedFolders(folders) {
        try { Lampa.Storage.set(STORAGE_FOLDERS_CACHE, JSON.stringify(folders || {})); } catch (_) {}
    }

    // ────────────────────────────────────────────────────────────────────
    // Lampa-compatible Java-style hash (Utils.hash из lampa-source)
    // Используется для вычисления hash эпизода/фильма для Lampa.Timeline.
    // Формула:
    //   episode hash:  Utils.hash(season + (season>10 ? ':' : '') + episode + original_name)
    //   movie hash:    Utils.hash(original_title)
    // ────────────────────────────────────────────────────────────────────
    function utilsHash(input) {
        var str = (input || '') + '';
        var h = 0;
        if (str.length === 0) return h + '';
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            h = ((h << 5) - h) + c;
            h = h & h; // 32-bit integer
        }
        return Math.abs(h) + '';
    }

    function episodeHash(originalName, season, episode) {
        if (!originalName) return null;
        var key = season + (season > 10 ? ':' : '') + episode + originalName;
        return utilsHash(key);
    }

    // ────────────────────────────────────────────────────────────────────
    // Network helpers
    // ────────────────────────────────────────────────────────────────────
    function httpJson(method, path, body) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            try { xhr.open(method, getServerUrl() + path, true); }
            catch (e) { reject({ status: 0, code: 'open_failed', error: e }); return; }
            if (body != null) xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('Accept', 'application/json');
            xhr.timeout = 15000;
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try { resolve(JSON.parse(xhr.responseText)); }
                    catch (e) { reject({ status: xhr.status, code: 'invalid_json' }); }
                } else {
                    reject({ status: xhr.status, body: xhr.responseText });
                }
            };
            xhr.onerror = function () { reject({ status: 0, code: 'network_error' }); };
            xhr.ontimeout = function () { reject({ status: 0, code: 'timeout' }); };
            try { xhr.send(body == null ? null : JSON.stringify(body)); }
            catch (e) { reject({ status: 0, code: 'send_failed', error: e }); }
        });
    }

    function serverGet(path)        { return httpJson('GET',  path, null); }
    function serverPost(path, body) { return httpJson('POST', path, body || {}); }

    // ────────────────────────────────────────────────────────────────────
    // Локализация
    // ────────────────────────────────────────────────────────────────────
    function registerLang() {
        if (!window.Lampa || !Lampa.Lang || typeof Lampa.Lang.add !== 'function') return;
        Lampa.Lang.add({
            trakt_v3_menu_title:    { ru: 'Trakt v3', en: 'Trakt v3', uk: 'Trakt v3' },
            trakt_v3_screen_title:  { ru: 'Trakt',    en: 'Trakt',    uk: 'Trakt' },
            trakt_v3_offline:       { ru: 'Сервер недоступен — показаны кешированные данные', en: 'Server unavailable — showing cached data', uk: 'Сервер недоступний — показано дані з кешу' },
            trakt_v3_no_cache:      { ru: 'Сервер недоступен и кеш пуст',                     en: 'Server unavailable and cache is empty',     uk: 'Сервер недоступний та кеш порожній' },
            trakt_v3_section_empty: { ru: 'пусто',     en: 'empty',     uk: 'порожньо' },
            trakt_v3_setting_url:        { ru: 'Адрес сервера',                                                                       en: 'Server URL',                                       uk: 'Адреса сервера' },
            trakt_v3_setting_url_descr:  { ru: 'URL прокси-сервера. Изменения проверяются запросом /api/health.',                       en: 'Proxy server URL. Validated via /api/health.',     uk: 'URL проксі-сервера. Перевіряється через /api/health.' },
            trakt_v3_setting_force:       { ru: 'Принудительная синхронизация',                                                          en: 'Force resync',                                     uk: 'Примусова синхронізація' },
            trakt_v3_setting_force_descr: { ru: 'Сбросить кеш активности и пересобрать снапшот на сервере.',                              en: 'Reset activity cache and rebuild snapshot.',       uk: 'Скинути кеш активності та зібрати знімок наново.' },
            trakt_v3_url_ok:        { ru: 'Сервер отвечает',                                                                         en: 'Server is reachable',                              uk: 'Сервер відповідає' },
            trakt_v3_url_fail:      { ru: 'Сервер не отвечает — URL не сохранён',                                                     en: 'Server unreachable — URL not saved',               uk: 'Сервер не відповідає — URL не збережено' },
            trakt_v3_force_ok:      { ru: 'Синхронизация выполнена',                                                                 en: 'Sync completed',                                   uk: 'Синхронізацію виконано' },
            trakt_v3_force_fail:    { ru: 'Ошибка синхронизации',                                                                    en: 'Sync failed',                                      uk: 'Помилка синхронізації' }
        });
    }

    // ────────────────────────────────────────────────────────────────────
    // Local state
    // ────────────────────────────────────────────────────────────────────
    // CARDS_INDEX: 'movie:603' / 'show:1399' → { in_watchlist, in_watched, in_collection, in_lists:[], status }.
    // Заполняется при каждом fetch /api/folders + optimistic-update после POST.
    var CARDS_INDEX = {};
    // STATES_INDEX: тот же ключ → {trakt_status, in_watchlist, in_watched, in_collection}.
    // Источник — light-endpoint /api/cards/states. Используется для overlay-значков
    // на превью КАРТОЧЕК (B1) — везде в Lampa, включая главную/поиск/source-плагины.
    var STATES_INDEX = {};
    // Список custom lists (id, slug, title) для динамической регистрации в sidebar.
    var CUSTOM_LISTS = [];
    // Карточка над которой открыто sidebar-меню. Ставится в hover:long listener.
    var currentFocusedCard = null;
    // Для дедупа регистрации custom lists
    var registeredListIds = {};

    function resolveCardKey(object) {
        if (!object) return null;
        var tmdb = object.id || (object.ids && object.ids.tmdb);
        if (!tmdb) return null;
        var type = (object.method === 'tv' || object.card_type === 'tv'
                    || object.name || object.original_name
                    || object.first_air_date || object.number_of_seasons || object.episode_run_time)
                ? 'show' : 'movie';
        return type + ':' + tmdb;
    }

    function getCardState(object) {
        var k = resolveCardKey(object);
        if (!k) return null;
        return CARDS_INDEX[k] || null;
    }

    function ensureCardState(object) {
        var k = resolveCardKey(object);
        if (!k) return null;
        if (!CARDS_INDEX[k]) {
            CARDS_INDEX[k] = {
                in_watchlist: false, in_watched: false, in_collection: false,
                in_lists: [], status: null
            };
        }
        return CARDS_INDEX[k];
    }

    function isCardActiveFor(object, action) {
        var st = getCardState(object);
        if (!st) return false;
        if (action === 'watchlist')  return !!st.in_watchlist;
        if (action === 'completed')  return !!st.in_watched;
        if (action === 'continue')   return st.status === 'continue';
        if (action === 'returning')  return st.status === 'returning';
        if (action.indexOf('list:') === 0) {
            var lid = Number(action.slice(5));
            return (st.in_lists || []).indexOf(lid) >= 0;
        }
        return false;
    }

    // Обновляем CARDS_INDEX и CUSTOM_LISTS из ответа /api/folders
    function ingestFoldersResponse(folders) {
        if (!folders) return;
        CARDS_INDEX = {};
        var allFolders = (folders.folders || []).concat(folders.custom_lists || []);
        allFolders.forEach(function (f) {
            (f.items || []).forEach(function (it) {
                if (!it || !it.id || !it.method) return;
                var type = it.method === 'tv' ? 'show' : 'movie';
                var k = type + ':' + it.id;
                if (!CARDS_INDEX[k]) {
                    CARDS_INDEX[k] = {
                        in_watchlist: false, in_watched: false, in_collection: false,
                        in_lists: [], status: null
                    };
                }
                if (it.trakt) {
                    var t = it.trakt;
                    CARDS_INDEX[k].in_watchlist  = !!t.in_watchlist;
                    CARDS_INDEX[k].in_watched    = !!t.in_watched;
                    CARDS_INDEX[k].in_collection = !!t.in_collection;
                    CARDS_INDEX[k].in_lists      = Array.isArray(t.in_lists) ? t.in_lists.slice() : [];
                    CARDS_INDEX[k].status        = t.status || null;
                }
            });
        });

        CUSTOM_LISTS = (folders.custom_lists || []).map(function (l) {
            return { id: l.id, slug: l.slug, title: l.title };
        });
    }

    // Оптимистичное обновление после успешного tap'а.
    function applyOptimisticUpdate(action, object) {
        var st = ensureCardState(object);
        if (!st) return null;
        if (action === 'watchlist') {
            st.in_watchlist = !st.in_watchlist;
            return st.in_watchlist;
        }
        if (action === 'completed') {
            st.in_watched = !st.in_watched;
            // status пересчитается на сервере — здесь не угадываем
            return st.in_watched;
        }
        if (action.indexOf('list:') === 0) {
            var lid = Number(action.slice(5));
            var idx = st.in_lists.indexOf(lid);
            if (idx >= 0) { st.in_lists.splice(idx, 1); return false; }
            st.in_lists.push(lid); return true;
        }
        return null;
    }

    // ────────────────────────────────────────────────────────────────────
    // Sidebar tap handler
    // ────────────────────────────────────────────────────────────────────
    function notify(text) {
        try { Lampa.Noty.show(String(text || '')); } catch (_) {}
    }

    // Если открыт наш Activity — перерисовываем его, чтобы новое состояние
    // карточки сразу было видно в рядах. Lampa.Activity.replace перезапускает
    // create() в текущей странице без push в стек.
    function refreshScreenIfActive() {
        try {
            var act = Lampa.Activity.active();
            if (act && act.component === COMPONENT) {
                Lampa.Activity.replace({
                    url: '',
                    title: Lampa.Lang.translate('trakt_v3_screen_title'),
                    component: COMPONENT,
                    page: 1
                });
            }
        } catch (_) {}
    }

    function handleSidebarTap(item, object) {
        // continue/returning — индикаторы, на тап ничего не делаем
        if (!item.isToggle) return;

        var key = resolveCardKey(object);
        if (!key) { notify('Не удалось определить карточку'); return; }
        var parts = key.split(':');
        var type = parts[0];
        var tmdb = Number(parts[1]);

        var endpoint = item.endpoint;
        // custom list → /api/tap/list/<id>
        if (item.action.indexOf('list:') === 0) {
            var listId = item.action.slice(5);
            endpoint = '/api/tap/list/' + listId;
        }

        serverPost(endpoint, { tmdb: tmdb, type: type })
            .then(function (resp) {
                if (resp && resp.ok) {
                    var added = applyOptimisticUpdate(item.action, object);
                    var msg = added ? (item.notifyAdded || (item.name + ': добавлено'))
                                    : (item.notifyRemoved || (item.name + ': убрано'));
                    notify(msg);
                    // Обновляем подписи sidebar (если юзер сразу снова откроет sidebar
                    // на той же карточке — увидит свежие ☐/☑).
                    updateAllOurPluginNames(object);
                    // B1: optimistic-обновление overlay-значков на превью.
                    applyOptimisticStateForTap(item.action, type, tmdb);
                    // Догружаем свежий полный snapshot из сервера, как только сервер
                    // переклассифицирует (in_progress→completed→returning ит.п.).
                    setTimeout(function () { fetchCardStates(); }, 1500);
                    // НЕ делаем refreshScreenIfActive() — экран не мигает,
                    // карточка переедет в нужный ряд при следующем заходе или sync.
                    // Когда сделаем иконки на превьюшках — они будут мгновенно
                    // отражать optimistic update, и re-render не нужен.
                } else {
                    notify('Ошибка: ' + ((resp && resp.error) || 'unknown'));
                }
            })
            .catch(function (err) {
                try { console.warn('[trakt_v3] tap failed', err); } catch (_) {}
                notify('Сервер недоступен');
            });
    }

    // ────────────────────────────────────────────────────────────────────
    // Sidebar labels через v2-стиль (мутация Manifest.plugins[i].name).
    //
    // Lampa берёт `plugin.name` статически из Manifest при построении меню —
    // поэтому чтобы динамически отображать состояние карточки (☐/☑/✓), нужно
    // мутировать `plugin.name` ПЕРЕД тем как Lampa откроет меню. Делаем это
    // в capture-phase обработчике `hover:long` (срабатывает раньше bubble-handler
    // в Lampa.Card, который и строит меню).
    //
    // Префиксы:
    //   toggle (Watchlist, Completed, custom-lists): ☐ если не active, ☑ если active
    //   индикатор (Continue, Returning):              '   ' если не active, '✓ ' если active
    // ────────────────────────────────────────────────────────────────────
    function isToggleAction(action) {
        for (var i = 0; i < SIDEBAR_FIXED.length; i++) {
            if (SIDEBAR_FIXED[i].action === action) return SIDEBAR_FIXED[i].isToggle;
        }
        return action.indexOf('list:') === 0; // custom lists всегда toggle
    }

    function baseNameOf(action) {
        for (var i = 0; i < SIDEBAR_FIXED.length; i++) {
            if (SIDEBAR_FIXED[i].action === action) return SIDEBAR_FIXED[i].name;
        }
        if (action.indexOf('list:') === 0) {
            var lid = Number(action.slice(5));
            for (var j = 0; j < CUSTOM_LISTS.length; j++) {
                if (CUSTOM_LISTS[j].id === lid) return CUSTOM_LISTS[j].title;
            }
        }
        return action;
    }

    function labelFor(action, object) {
        var baseName = baseNameOf(action);
        var active = object ? isCardActiveFor(object, action) : false;
        var prefix = isToggleAction(action)
            ? (active ? '☑ ' : '☐ ')
            : (active ? '✓ ' : '   ');
        return prefix + baseName;
    }

    // Мутирует name на каждой нашей записи в Lampa.Manifest.plugins на основе
    // состояния переданной карточки. Lampa.Card.onMenu синхронно читает plugin.name —
    // если name свежий ДО события 'hover:long' (через capture hook), меню сразу
    // отрендерит правильно.
    function updateAllOurPluginNames(card) {
        if (!window.Lampa || !Lampa.Manifest || !Array.isArray(Lampa.Manifest.plugins)) return;
        try {
            for (var i = 0; i < Lampa.Manifest.plugins.length; i++) {
                var entry = Lampa.Manifest.plugins[i];
                if (!entry || typeof entry.__trakt_v3 !== 'string') continue;
                var action = entry.__trakt_v3.replace(/^trakt_v3:/, '');
                entry.name = labelFor(action, card);
            }
        } catch (e) {
            try { console.warn('[trakt_v3] updateAllOurPluginNames failed', e); } catch (_) {}
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Capture-phase hook на 'hover:long' — стреляет ПЕРЕД bubble-listener Lampa
    // в src/interaction/card.js. Мутирует Manifest.plugins[i].name для нашей
    // фокусной карточки ДО того как Lampa.Card.onMenu прочитает plugin.name.
    // ────────────────────────────────────────────────────────────────────
    function installHoverLongHook() {
        if (typeof document === 'undefined' || !document.addEventListener) return;
        if (window.__trakt_v3_hover_installed) return;
        window.__trakt_v3_hover_installed = true;
        document.addEventListener('hover:long', function (e) {
            try {
                var el = e && e.target;
                while (el && el.nodeType === 1 && el !== document.body) {
                    if (el.card_data) {
                        var card = el.card_data;
                        currentFocusedCard = card;
                        updateAllOurPluginNames(card);
                        return;
                    }
                    el = el.parentElement;
                }
            } catch (err) {
                try { console.warn('[trakt_v3] hover:long handler err', err); } catch (_) {}
            }
        }, true /* capture phase — до Lampa-листенера */);
        try { console.log('[trakt_v3] hover:long capture hook installed'); } catch (_) {}
    }

    // ────────────────────────────────────────────────────────────────────
    // Регистрация sidebar entries в Lampa.Manifest.plugins
    // ────────────────────────────────────────────────────────────────────
    function registerCardSidebar() {
        if (!window.Lampa || !Lampa.Manifest) return;
        if (!Array.isArray(Lampa.Manifest.plugins)) Lampa.Manifest.plugins = [];
        SIDEBAR_FIXED.forEach(function (item) {
            var marker = 'trakt_v3:' + item.action;
            for (var i = 0; i < Lampa.Manifest.plugins.length; i++) {
                if (Lampa.Manifest.plugins[i] && Lampa.Manifest.plugins[i].__trakt_v3 === marker) return;
            }
            Lampa.Manifest.plugins.push({
                __trakt_v3: marker,
                type: 'video',
                // Дефолтное name (без open карточки). updateAllOurPluginNames
                // мутирует его на каждом hover:long — это и есть механизм
                // отображения состояния, потому что Lampa берёт title пункта
                // именно из outer plugin.name.
                name: labelFor(item.action),
                onContextMenu: function (object) { return { name: labelFor(item.action, object) }; },
                onContextLauch: function (object) { handleSidebarTap(item, object); }
            });
        });
        try { console.log('[trakt_v3] sidebar plugins registered (fixed):', SIDEBAR_FIXED.map(function (s) { return s.action; }).join(',')); } catch (_) {}
    }

    function registerCustomListsInSidebar() {
        if (!window.Lampa || !Lampa.Manifest || !Array.isArray(Lampa.Manifest.plugins)) return;
        CUSTOM_LISTS.forEach(function (l) {
            if (registeredListIds[l.id]) return;
            registeredListIds[l.id] = true;
            var listAction = 'list:' + l.id;
            var item = {
                action: listAction,
                name: l.title,
                isToggle: true,
                endpoint: '/api/tap/list/' + l.id
            };
            Lampa.Manifest.plugins.push({
                __trakt_v3: 'trakt_v3:' + listAction,
                type: 'video',
                name: labelFor(listAction),
                onContextMenu: function (object) { return { name: labelFor(listAction, object) }; },
                onContextLauch: function (object) { handleSidebarTap(item, object); }
            });
        });
        try { console.log('[trakt_v3] sidebar plugins registered (custom lists):', CUSTOM_LISTS.length); } catch (_) {}
    }

    // ────────────────────────────────────────────────────────────────────
    // D1a: sync watched-эпизодов в Lampa-карточку (read-only)
    //
    // При open full-карточки шоу — fetch /api/show/<tmdb>/episodes →
    // для каждого watched-эпизода вычислить hash → Lampa.Timeline.update({...}).
    // Lampa нативно отрисует watched-маркеры в карточке.
    // ────────────────────────────────────────────────────────────────────
    // Throttle re-sync: skip если последний sync для этого tmdb был < 3 сек назад.
    // Раньше использовался сессионный cache (episodesSynced) — но он мешал
    // подхватить изменения когда юзер удалил watched в Trakt и снова открыл карточку.
    var lastEpSyncTime = {}; // tmdb → ms timestamp

    // Map: hash → {tmdb, season, episode}. Заполняется при open карточки шоу.
    // Используется в Timeline.update listener для обратного маппинга.
    var hashToEpisode = {};

    // Set of hashes недавно записанных нами programmatically (в applyEpisodesToTimeline
    // или после tap'а). Используется чтобы игнорировать соответствующие update-events
    // и не уйти в loop.
    var recentlyPushedHashes = {};
    function markPushed(hash) {
        recentlyPushedHashes[hash] = Date.now();
        // Очищаем через 3 сек
        setTimeout(function () { delete recentlyPushedHashes[hash]; }, 3000);
    }
    function wasRecentlyPushed(hash) {
        var t = recentlyPushedHashes[hash];
        return t && (Date.now() - t < 3000);
    }

    // D1d: throttled POST /api/progress per-hash (60 сек).
    var lastProgressSent = {}; // hash → ms
    var PROGRESS_THROTTLE_MS = 60000;
    function sendProgressThrottled(hash, road) {
        var now = Date.now();
        if (lastProgressSent[hash] && (now - lastProgressSent[hash]) < PROGRESS_THROTTLE_MS) return;
        lastProgressSent[hash] = now;

        var time = Math.max(0, Math.floor(Number(road.time) || 0));
        var duration = Math.max(0, Math.floor(Number(road.duration) || 0));
        var percent = Math.max(0, Math.min(100, Number(road.percent) || 0));
        if (duration <= 0) return;

        // Найдём что это — эпизод или фильм.
        var ep = hashToEpisode[hash];
        if (ep) {
            serverPost('/api/progress', {
                tmdb: ep.tmdb, type: 'show',
                season: ep.season, episode: ep.episode,
                time: time, duration: duration, percent: percent
            }).catch(function () { delete lastProgressSent[hash]; });
            return;
        }
        var mv = hashToMovie[hash];
        if (mv) {
            serverPost('/api/progress', {
                tmdb: mv.tmdb, type: 'movie',
                time: time, duration: duration, percent: percent
            }).catch(function () { delete lastProgressSent[hash]; });
        }
    }

    // hashToMovie: hash → {tmdb} для open карточки фильма.
    var hashToMovie = {};

    function syncEpisodesForCard(cardData) {
        if (!cardData) return;
        var tmdb = cardData.id || (cardData.ids && cardData.ids.tmdb);
        var method = cardData.method || cardData.card_type;
        if (!tmdb) return;

        // Для фильма — регистрируем hash + подтянуть paused-position если есть.
        if (method === 'movie') {
            var origTitle = cardData.original_title || cardData.original_name || cardData.title;
            if (origTitle) {
                var mh = utilsHash(origTitle);
                hashToMovie[mh] = { tmdb: tmdb };
                try { console.log('[trakt_v3] movie hash registered tmdb=' + tmdb + ' hash=' + mh); } catch (_) {}

                // D1d: если у фильма paused-position — устанавливаем для resume.
                serverGet('/api/card/' + tmdb + '?type=movie').then(function (resp) {
                    if (!resp || !resp.movie_progress) return;
                    var mp = resp.movie_progress;
                    if (mp.time > 0 && mp.duration > 0) {
                        markPushed(mh);
                        try {
                            Lampa.Timeline.update({
                                hash: mh, percent: mp.percent, time: mp.time, duration: mp.duration, profile: 0
                            });
                            try { console.log('[trakt_v3] movie progress restored tmdb=' + tmdb + ' time=' + mp.time + ' duration=' + mp.duration); } catch (_) {}
                        } catch (err) {}
                    }
                }).catch(function () {});
            }
            return;
        }

        if (method !== 'tv') return; // фильтруем не-tv/не-movie

        // Throttle: не делать sync если последний был < 3 сек назад
        var now = Date.now();
        if (lastEpSyncTime[tmdb] && (now - lastEpSyncTime[tmdb]) < 3000) return;
        lastEpSyncTime[tmdb] = now;

        serverGet('/api/show/' + tmdb + '/episodes')
            .then(function (resp) {
                if (!resp || !resp.ok) return;
                var originalName = resp.original_name || cardData.original_name;
                if (!originalName) return;

                var episodes = resp.episodes || [];
                var pushedWatched = 0, pushedUnwatched = 0;

                // Сервер возвращает ВСЕ aired (watched + not-watched aired) + progress
                // для эпизодов с paused-position. Регистрируем hashes, пушим Timeline.update.
                var pushedProgress = 0;
                for (var i = 0; i < episodes.length; i++) {
                    var e = episodes[i];
                    if (!e) continue;
                    var hash = episodeHash(originalName, e.season, e.episode);
                    if (!hash) continue;
                    hashToEpisode[hash] = { tmdb: tmdb, season: e.season, episode: e.episode };
                    var percent = 0, time = 0, duration = 0;
                    if (e.watched) {
                        percent = 95;
                    } else if (e.progress && e.progress.time > 0 && e.progress.duration > 0) {
                        // D1d: paused-эпизод — ставим resume position
                        percent = e.progress.percent;
                        time = e.progress.time;
                        duration = e.progress.duration;
                        pushedProgress++;
                    }
                    markPushed(hash);
                    try {
                        Lampa.Timeline.update({
                            hash: hash, percent: percent, time: time, duration: duration, profile: 0
                        });
                        if (e.watched) pushedWatched++;
                        else if (time === 0) pushedUnwatched++;
                    } catch (err) {
                        try { console.warn('[trakt_v3] Timeline.update failed', err); } catch (_) {}
                    }
                }
                try { console.log('[trakt_v3] episodes synced tmdb=' + tmdb + ' watched=' + pushedWatched + ' unwatched=' + pushedUnwatched + ' paused=' + pushedProgress); } catch (_) {}
            })
            .catch(function (err) {
                try { console.warn('[trakt_v3] episodes sync failed for ' + tmdb, err); } catch (_) {}
                // Сбрасываем throttle чтобы ретрай мог пройти на следующий open
                delete lastEpSyncTime[tmdb];
            });
    }

    // Регистрируем hashToEpisode для ВСЕХ эпизодов всех сезонов карточки.
    // Идём по seasons[].episode_count (если есть). Если нет — по number_of_seasons и
    // дефолтному 30 эпизодов на сезон (с запасом).
    function registerAllEpisodeHashes(cardData, originalName) {
        if (!originalName) return;
        var tmdb = cardData.id || (cardData.ids && cardData.ids.tmdb);
        if (!tmdb) return;
        var seasons = Array.isArray(cardData.seasons) ? cardData.seasons : [];
        if (seasons.length) {
            seasons.forEach(function (s) {
                var sn = s.season_number;
                var count = s.episode_count || 30;
                if (sn === undefined) return;
                for (var ep = 1; ep <= count; ep++) {
                    var h = episodeHash(originalName, sn, ep);
                    if (h) hashToEpisode[h] = { tmdb: tmdb, season: sn, episode: ep };
                }
            });
        } else {
            // fallback — number_of_seasons × 30 эпизодов
            var ns = cardData.number_of_seasons || 1;
            for (var s = 1; s <= ns; s++) {
                for (var ep2 = 1; ep2 <= 30; ep2++) {
                    var h2 = episodeHash(originalName, s, ep2);
                    if (h2) hashToEpisode[h2] = { tmdb: tmdb, season: s, episode: ep2 };
                }
            }
        }
    }

    // Listener для Timeline.update: ловит ручные клики юзера на эпизод.
    // percent === 0 → unwatched, иначе → watched.
    function installTimelineUpdateHook() {
        if (!window.Lampa || !Lampa.Timeline || !Lampa.Timeline.listener) return;
        if (window.__trakt_v3_timeline_hook_installed) return;
        window.__trakt_v3_timeline_hook_installed = true;
        Lampa.Timeline.listener.follow('update', function (e) {
            try {
                var data = e && e.data;
                if (!data || !data.hash) return;
                var hash = data.hash;
                // Игнорируем events которые мы сами породили
                if (wasRecentlyPushed(hash)) return;

                var road = data.road || {};
                var percent = Number(road.percent) || 0;
                var duration = Number(road.duration) || 0;

                // Различаем источник update:
                //   duration === 0 → ручной toggle (клик в карточке).
                //   duration  > 0 → авто-update от плеера во время просмотра.
                var isManual = duration === 0;
                var watched;
                if (isManual) {
                    // ручной клик: percent=95 → mark, percent=0 → unmark
                    watched = percent > 0;
                } else {
                    // play: при <80% — D1d cross-device progress (throttled POST).
                    //       при >=80% — D1c mark watched (Trakt-стандарт).
                    if (percent < 80) {
                        // D1d: cross-device прогресс через наш сервер.
                        sendProgressThrottled(hash, road);
                        return;
                    }
                    watched = true;
                }

                // Эпизод?
                var epInfo = hashToEpisode[hash];
                if (epInfo) {
                    serverPost('/api/episode/watch', {
                        tmdb: epInfo.tmdb,
                        season: epInfo.season,
                        episode: epInfo.episode,
                        watched: watched
                    }).then(function (resp) {
                        if (resp && resp.ok && resp.action !== 'noop') {
                            try { console.log('[trakt_v3] episode ' + (watched ? 'watched' : 'unwatched') + ' tmdb=' + epInfo.tmdb + ' S' + epInfo.season + 'E' + epInfo.episode + ' (' + (isManual ? 'manual' : 'auto>=80%') + ')'); } catch (_) {}
                        } else if (!resp || !resp.ok) {
                            notify('Ошибка отметки эпизода: ' + ((resp && resp.error) || 'unknown'));
                        }
                    }).catch(function (err) {
                        try { console.warn('[trakt_v3] episode/watch failed', err); } catch (_) {}
                        notify('Сервер недоступен');
                    });
                    return;
                }

                // Фильм?
                var movieInfo = hashToMovie[hash];
                if (movieInfo) {
                    serverPost('/api/movie/watch', {
                        tmdb: movieInfo.tmdb,
                        watched: watched
                    }).then(function (resp) {
                        if (resp && resp.ok && resp.action !== 'noop') {
                            try { console.log('[trakt_v3] movie ' + (watched ? 'watched' : 'unwatched') + ' tmdb=' + movieInfo.tmdb + ' (' + (isManual ? 'manual' : 'auto>=80%') + ')'); } catch (_) {}
                        } else if (!resp || !resp.ok) {
                            notify('Ошибка отметки фильма: ' + ((resp && resp.error) || 'unknown'));
                        }
                    }).catch(function (err) {
                        try { console.warn('[trakt_v3] movie/watch failed', err); } catch (_) {}
                        notify('Сервер недоступен');
                    });
                    return;
                }
                // Иначе: незарегистрированный hash — игнорируем (не наш контент).
            } catch (err) {
                try { console.warn('[trakt_v3] Timeline.update handler err', err); } catch (_) {}
            }
        });
        try { console.log('[trakt_v3] Timeline.update hook installed'); } catch (_) {}
    }

    // ────────────────────────────────────────────────────────────────────
    // B1: Overlay-значки состояния на превью КАРТОЧЕК (везде в Lampa).
    //
    // Источник данных — STATES_INDEX (light-fetch /api/cards/states).
    // Hook — Lampa.Listener.follow('card', e => e.type === 'build') шлёт каждую
    // отрендеренную плитку (главная, ряды нашего плагина, поиск, source-плагины).
    //
    // Стек значков расположен top-right. Native Lampa-значок (watchlist
    // bookmark) Lampa тоже рисует в углу — пока не перекрываем (Eugene:
    // «top-right свободен, потом будем думать»). Если визуально каша —
    // добавим .card__icons{display:none} в инжект.
    // ────────────────────────────────────────────────────────────────────
    var BADGE_DEFS = [
        // priority по визуальной значимости (сверху-вниз в стеке)
        { key: 'returning',   symbol: 'N',  cls: 'returning',   test: function (s) { return s.trakt_status === 'returning'; } },
        { key: 'in_progress', symbol: '▶', cls: 'in_progress', test: function (s) { return s.trakt_status === 'in_progress' || s.trakt_status === 'continue'; } },
        { key: 'completed',   symbol: '✓', cls: 'completed',   test: function (s) { return s.trakt_status === 'completed' || (s.in_watched && !s.trakt_status); } },
        { key: 'dropped',     symbol: '×', cls: 'dropped',     test: function (s) { return s.trakt_status === 'dropped'; } },
        { key: 'watchlist',   symbol: '★', cls: 'watchlist',   test: function (s) { return !!s.in_watchlist; } },
        { key: 'collection',  symbol: '▣', cls: 'collection',  test: function (s) { return !!s.in_collection; } }
    ];

    function ensureBadgesStyleInjected() {
        if (window.__trakt_v3_badges_style_injected) return;
        window.__trakt_v3_badges_style_injected = true;
        try {
            var css = ''
                + '.trakt-badges{position:absolute;top:0.4em;right:0.4em;display:flex;flex-direction:column;gap:0.25em;z-index:30;pointer-events:none;}'
                + '.trakt-badge{width:1.7em;height:1.7em;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font-size:0.95em;line-height:1;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.6);font-family:Arial,sans-serif;}'
                + '.trakt-badge--completed{background:#43a047;}'
                + '.trakt-badge--in_progress{background:#1e88e5;}'
                + '.trakt-badge--returning{background:#fb8c00;}'
                + '.trakt-badge--watchlist{background:#fdd835;color:#222;}'
                + '.trakt-badge--dropped{background:#757575;}'
                + '.trakt-badge--collection{background:#8e24aa;}'
                // B1.5: progress-bar внизу .card__view
                + '.trakt-progress{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(0,0,0,0.45);z-index:30;pointer-events:none;overflow:hidden;}'
                + '.trakt-progress__fill{height:100%;background:#1e88e5;transition:width .2s ease;}'
                + '.trakt-progress--returning .trakt-progress__fill{background:#fb8c00;}';
            var st = document.createElement('style');
            st.id = 'trakt_v3_badges_style';
            st.textContent = css;
            document.head.appendChild(st);
        } catch (_) {}
    }

    // B1.5: progress-bar внизу превью.
    // Возвращает {percent, variant} или null если бар показывать не надо.
    //   variant: 'in_progress' (синий) | 'returning' (оранжевый)
    // Логика visibility (согласовано с Eugene):
    //   show: только если started и не completed/returning (бар несёт инфу)
    //         completed = 0 → ничего; completed === aired → ничего (= returning или completed)
    //   movie: только paused-position 3..79% (артефакт открытия / уже watched)
    function computeProgressBar(state, type) {
        if (!state) return null;
        if (type === 'show') {
            // Полагаемся ТОЛЬКО на trakt_status. in_watched часто true для continue
            // (юзер смотрел всё, потом вышли новые эпизоды — classifier перевёл в continue).
            if (state.trakt_status !== 'continue' && state.trakt_status !== 'in_progress') return null;
            var p = state.progress;
            if (!p || !p.aired) return null;
            if (p.completed <= 0 || p.completed >= p.aired) return null;
            var pct = Math.round((p.completed / p.aired) * 100);
            return { percent: Math.max(2, Math.min(98, pct)), variant: 'in_progress' };
        }
        if (type === 'movie') {
            if (state.in_watched) return null;
            var mp = state.movie_progress;
            if (!mp || !Number.isFinite(mp.percent)) return null;
            if (mp.percent < 3 || mp.percent >= 80) return null;
            return { percent: Math.round(mp.percent), variant: 'in_progress' };
        }
        return null;
    }

    function buildProgressBarHtml(bar) {
        if (!bar) return '';
        var vCls = bar.variant === 'returning' ? ' trakt-progress--returning' : '';
        return '<div class="trakt-progress' + vCls + '" data-trakt-progress="1">'
             + '<div class="trakt-progress__fill" style="width:' + bar.percent + '%"></div>'
             + '</div>';
    }

    function buildBadgesHtml(state) {
        if (!state) return '';
        var html = '';
        for (var i = 0; i < BADGE_DEFS.length; i++) {
            var d = BADGE_DEFS[i];
            if (d.test(state)) {
                html += '<span class="trakt-badge trakt-badge--' + d.cls + '">' + d.symbol + '</span>';
            }
        }
        if (!html) return '';
        return '<div class="trakt-badges" data-trakt-badges="1">' + html + '</div>';
    }

    // Получить (tmdb, type) карточки. Канонический способ в Lampa — DOM-нода
    // `.card` имеет property `.card_data` с полным объектом (см. rate.js):
    //   data.id          → TMDB id
    //   data.seasons / data.first_air_date / data.original_name → признаки tv
    // data-id атрибут на .card часто отсутствует.
    function getCardMeta(cardEl) {
        if (!cardEl) return null;
        var data = cardEl.card_data;
        if (!data || !data.id) return null;
        var isTv = !!(data.seasons || data.first_air_date || data.original_name
                      || data.number_of_seasons || data.episode_run_time
                      || data.method === 'tv' || data.card_type === 'tv');
        return { tmdb: String(data.id), type: isTv ? 'show' : 'movie' };
    }

    function lookupStateByCardEl(cardEl) {
        var meta = getCardMeta(cardEl);
        if (!meta) return null;
        var primary = meta.type + ':' + meta.tmdb;
        var fallback = (meta.type === 'show' ? 'movie:' : 'show:') + meta.tmdb;
        return STATES_INDEX[primary] || STATES_INDEX[fallback] || null;
    }

    function applyBadgesToCardEl(cardEl, state) {
        if (!cardEl) return;
        // Контейнер для оверлея — .card__view (poster wrapper). Внутри Lampa
        // у него уже position:relative.
        var host = (cardEl.querySelector ? cardEl.querySelector('.card__view') : null) || cardEl;
        if (!host) return;
        // Удаляем старые оверлеи (re-render после optimistic update / повторной обработки).
        var prevB = host.querySelector ? host.querySelector(':scope > [data-trakt-badges]') : null;
        if (prevB && prevB.parentNode) prevB.parentNode.removeChild(prevB);
        var prevP = host.querySelector ? host.querySelector(':scope > [data-trakt-progress]') : null;
        if (prevP && prevP.parentNode) prevP.parentNode.removeChild(prevP);
        if (!state) return;
        // Type для progress-расчёта берём по тому же признаку, что getCardMeta.
        var meta = getCardMeta(cardEl);
        var type = meta ? meta.type : null;
        var bar = computeProgressBar(state, type);

        var html = buildBadgesHtml(state) + buildProgressBarHtml(bar);
        if (!html) return;
        // Гарантируем relative у host (на случай если Lampa-стиль не задал).
        try {
            var cs = window.getComputedStyle(host);
            if (cs && cs.position === 'static') host.style.position = 'relative';
        } catch (_) {}
        host.insertAdjacentHTML('beforeend', html);
    }

    // Перерисовать badges на всех уже отрендеренных плитках с этим tmdb.
    // Вызывается после optimistic update: новое состояние сразу видно.
    function refreshBadgesForTmdb(tmdb) {
        try {
            var t = String(tmdb);
            var nodes = document.querySelectorAll('.card');
            for (var i = 0; i < nodes.length; i++) {
                var d = nodes[i].card_data;
                if (d && String(d.id) === t) {
                    applyBadgesToCardEl(nodes[i], lookupStateByCardEl(nodes[i]));
                }
            }
        } catch (_) {}
    }

    // Обработать одну карточку — найти состояние и нарисовать badges.
    function processCardEl(cardEl) {
        if (!cardEl) return;
        var st = lookupStateByCardEl(cardEl);
        applyBadgesToCardEl(cardEl, st);
    }

    // Один проход по всем .card в DOM (initial pass + safety net).
    function processAllCards() {
        try {
            var nodes = document.querySelectorAll('.card');
            for (var i = 0; i < nodes.length; i++) processCardEl(nodes[i]);
        } catch (_) {}
    }

    // MutationObserver-паттерн (как у interface_mod.js): watch новые .card
    // и батчево обрабатываем через rAF. Это надёжно работает на ВСЕХ страницах
    // Lampa, без зависимости от существования 'card' event.
    function installCardBuildHook() {
        if (window.__trakt_v3_card_hook_installed) return;
        window.__trakt_v3_card_hook_installed = true;
        ensureBadgesStyleInjected();

        var pending = new Set();
        var scheduled = false;
        function flush() {
            scheduled = false;
            pending.forEach(processCardEl);
            pending.clear();
        }
        function schedule(node) {
            pending.add(node);
            if (!scheduled) {
                scheduled = true;
                (window.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(flush);
            }
        }

        try {
            var obs = new MutationObserver(function (mutations) {
                for (var i = 0; i < mutations.length; i++) {
                    var m = mutations[i];
                    if (!m.addedNodes || !m.addedNodes.length) continue;
                    for (var j = 0; j < m.addedNodes.length; j++) {
                        var n = m.addedNodes[j];
                        if (n.nodeType !== 1) continue;
                        if (n.classList && n.classList.contains('card')) {
                            schedule(n);
                        } else if (n.querySelectorAll) {
                            var inner = n.querySelectorAll('.card');
                            for (var k = 0; k < inner.length; k++) schedule(inner[k]);
                        }
                    }
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
        } catch (err) {
            try { console.warn('[trakt_v3] MutationObserver setup err', err); } catch (_) {}
        }

        // Initial pass — для карточек, отрисованных до установки наблюдателя.
        processAllCards();
        try { console.log('[trakt_v3] card-badges observer installed'); } catch (_) {}
    }

    function fetchCardStates() {
        return serverGet('/api/cards/states').then(function (resp) {
            if (!resp || !resp.cards) return;
            // Преобразуем {tmdb: {movie?: state, show?: state}} в наш плоский map.
            var next = {};
            for (var tmdb in resp.cards) {
                if (!Object.prototype.hasOwnProperty.call(resp.cards, tmdb)) continue;
                var entry = resp.cards[tmdb];
                if (entry.movie) next['movie:' + tmdb] = entry.movie;
                if (entry.show)  next['show:'  + tmdb] = entry.show;
            }
            STATES_INDEX = next;
            try { console.log('[trakt_v3] STATES_INDEX loaded, items=' + Object.keys(next).length); } catch (_) {}
            // STATES мог прийти после того как карточки уже отрисованы — подкрасить.
            try { processAllCards(); } catch (_) {}
        }).catch(function (err) {
            try { console.warn('[trakt_v3] fetchCardStates failed', err); } catch (_) {}
        });
    }

    // После optimistic update sidebar-tap'а — обновляем STATES_INDEX и
    // перерисовываем badges на видимых карточках.
    function applyOptimisticStateForTap(action, type, tmdb) {
        var k = type + ':' + tmdb;
        if (!STATES_INDEX[k]) {
            STATES_INDEX[k] = {
                trakt_status: null, in_watchlist: false, in_watched: false, in_collection: false
            };
        }
        var s = STATES_INDEX[k];
        if (action === 'watchlist') s.in_watchlist = !s.in_watchlist;
        else if (action === 'completed') {
            s.in_watched = !s.in_watched;
            // trakt_status пересчитается на сервере — обнулим до следующего fetch.
            s.trakt_status = s.in_watched ? 'completed' : null;
        }
        // Для list:N в STATES не храним (не отображаем как badge) — пропуск.
        refreshBadgesForTmdb(tmdb);
    }

    // Hook на open full-карточки. Lampa шлёт event 'full' с типом 'complite'
    // когда карточка собрана и видна юзеру.
    function installFullCardHook() {
        if (!window.Lampa || !Lampa.Listener) return;
        if (window.__trakt_v3_full_hook_installed) return;
        window.__trakt_v3_full_hook_installed = true;
        Lampa.Listener.follow('full', function (e) {
            if (!e) return;
            // Diag: посмотреть всё, что приходит, до фильтрации.
            try {
                var d = e.data || {};
                var dm = d.movie || (e.object && e.object.movie) || null;
                console.log('[trakt_v3] full event:', e.type,
                    '|e.data keys:', Object.keys(d || {}).join(','),
                    '|d.id=', d.id,
                    '|d.method=', d.method,
                    '|d.original_title=', d.original_title,
                    '|d.original_name=', d.original_name,
                    '|d.movie?', !!d.movie,
                    '|movie.id=', dm && dm.id,
                    '|movie.original_title=', dm && dm.original_title,
                    '|movie.original_name=', dm && dm.original_name);
            } catch (_) {}
            // Lampa src/components/full.js шлёт type:'build' когда full-карточка
            // построена и видна. Также есть 'start' (юзер начал смотреть) и
            // 'complite' (завершил) — для D1c.
            if (e.type === 'build') {
                // Lampa передаёт реальный movie-объект внутри e.data.movie (см.
                // interface_mod.js: data.data.movie). Иногда поля дублируются
                // на e.data, иногда нет. Используем .movie, fallback на e.data.
                var cardData = (e.data && e.data.movie) || e.data;
                if (cardData) syncEpisodesForCard(cardData);
            }
        });
        try { console.log('[trakt_v3] Lampa.Listener.full hook installed'); } catch (_) {}
    }

    // ────────────────────────────────────────────────────────────────────
    // MainComponent — Activity с 4 рядами
    // ────────────────────────────────────────────────────────────────────
    function MainComponent(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var html = $('<div class="trakt_v3"></div>');
        var body = $('<div class="trakt_v3__body"></div>');
        var lines = [];
        var lastFocused = null;

        this.activity = null;

        function escapeHtml(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function buildSectionLine(title, items) {
            var data = {
                title: title + ' (' + items.length + ')',
                results: items,
                source: 'tmdb',
                noimage: true
            };
            var params = { object: object, nomore: true };
            var line = new Lampa.InteractionLine(data, params);
            line.create();

            line.onFocus = function (card_data) {
                lastFocused = line;
                if (card_data) currentFocusedCard = card_data;
            };
            line.onEnter = function (target, card_data) {
                if (!card_data) return;
                Lampa.Activity.push({
                    url: '', component: 'full',
                    id: card_data.id, method: card_data.method,
                    card: card_data, source: 'tmdb'
                });
            };
            line.onUp = function () {
                var idx = lines.indexOf(line);
                var prev = idx > 0 ? lines[idx - 1] : null;
                if (prev) prev.toggle();
                else Lampa.Controller.toggle('head');
            };
            line.onDown = function () {
                var idx = lines.indexOf(line);
                var next = idx >= 0 && idx < lines.length - 1 ? lines[idx + 1] : null;
                if (next) next.toggle();
            };
            line.onLeft = function () { Lampa.Controller.toggle('menu'); };
            line.onBack = self.back;
            line.onToggle = function () {
                lastFocused = line;
                try { scroll.update($(line.render(true)), true); } catch (_) {}
            };
            return line;
        }

        function buildEmptyLine(title) {
            return $(
                '<div class="items-line items-line--type-default trakt_v3__empty-line">' +
                  '<div class="items-line__head">' +
                    '<div class="items-line__title">' + escapeHtml(title) + ' (0)</div>' +
                  '</div>' +
                  '<div class="items-line__body" style="padding:0.7em 1em;opacity:0.55">' +
                    escapeHtml(Lampa.Lang.translate('trakt_v3_section_empty')) +
                  '</div>' +
                '</div>'
            );
        }

        function buildSections(folders) {
            (folders.folders || []).forEach(function (f) {
                var items = f.items || [];
                if (items.length === 0) {
                    body.append(buildEmptyLine(f.title));
                } else {
                    var line = buildSectionLine(f.title, items);
                    lines.push(line);
                    body.append(line.render());
                }
            });
        }

        function showOfflineBanner() {
            var $banner = $(
                '<div class="trakt_v3__banner" style="padding:0.7em 1em;margin:0 1em 1em;background:rgba(255,160,0,0.15);border-left:3px solid #ffa000;color:#ffa000;font-size:0.85em;">' +
                escapeHtml(Lampa.Lang.translate('trakt_v3_offline')) +
                '</div>'
            );
            html.prepend($banner);
        }

        function renderFromFolders(folders, isOffline) {
            ingestFoldersResponse(folders);
            registerCustomListsInSidebar();
            buildSections(folders);

            if (isOffline) showOfflineBanner();

            scroll.minus();
            scroll.append(body);
            html.append(scroll.render());

            if (self.activity) self.activity.loader(false);

            // Триггер 'visible' для подгрузки постеров без пользовательского scroll
            lines.forEach(function (line) {
                try {
                    var el = line.render(true);
                    if (el && typeof el.dispatchEvent === 'function') {
                        el.dispatchEvent(new Event('visible'));
                    }
                } catch (_) {}
            });
            if (self.activity && typeof self.activity.toggle === 'function') {
                self.activity.toggle();
            }
        }

        this.create = function () {
            if (this.activity) this.activity.loader(true);

            serverGet('/api/folders').then(function (folders) {
                writeCachedFolders(folders);
                renderFromFolders(folders, false);
            }).catch(function (err) {
                try { console.warn('[trakt_v3] /api/folders fetch failed', err); } catch (_) {}
                var cached = readCachedFolders();
                if (cached) {
                    renderFromFolders(cached, true);
                } else {
                    self.empty(Lampa.Lang.translate('trakt_v3_no_cache'));
                }
            });

            return this.render();
        };

        this.empty = function (text) {
            var $msg = $(
                '<div class="empty" style="padding:2em;text-align:center;">' +
                  '<div class="empty__title">' + escapeHtml(text || '') + '</div>' +
                '</div>'
            );
            html.empty().append($msg);
            if (this.activity) this.activity.loader(false);
        };

        this.start = function () {
            if (this.activity) this.activity.loader(false);
            Lampa.Controller.add('content', {
                link: self,
                toggle: function () {
                    var target = lastFocused || lines[0] || null;
                    if (target) target.toggle();
                    else Lampa.Controller.toggle('head');
                },
                left:  function () { if (Navigator.canmove('left'))  Navigator.move('left');  else Lampa.Controller.toggle('menu'); },
                right: function () { if (Navigator.canmove('right')) Navigator.move('right'); },
                up:    function () { if (Navigator.canmove('up'))    Navigator.move('up');    else Lampa.Controller.toggle('head'); },
                down:  function () { if (Navigator.canmove('down'))  Navigator.move('down'); },
                back:  this.back
            });
            Lampa.Controller.toggle('content');
        };

        this.back = function () { Lampa.Activity.backward(); };
        this.pause = function () {};
        this.stop  = function () {};
        this.render = function () { return html; };
        this.destroy = function () {
            try { lines.forEach(function (l) { try { l.destroy(); } catch (_) {} }); } catch (_) {}
            try { scroll.destroy(); } catch (_) {}
            html.remove();
            lines = [];
        };
    }

    // ────────────────────────────────────────────────────────────────────
    // DOM-инъекция пункта в левое меню
    // ────────────────────────────────────────────────────────────────────
    function ICON() {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="7 13 10 16 17 9"/></svg>';
    }

    function injectMenuItem() {
        if (!window.$ || !window.Lampa) return;
        var $list = $('.menu .menu__list').eq(0);
        if (!$list.length) return;
        if ($list.find('[data-trakt-v3="' + MENU_DATA_ATTR + '"]').length) return;
        var title = Lampa.Lang.translate('trakt_v3_menu_title') + ' ' + VERSION;
        var $item = $(
            '<li class="menu__item selector" data-trakt-v3="' + MENU_DATA_ATTR + '">' +
                '<div class="menu__ico">' + ICON() + '</div>' +
                '<div class="menu__text">' + title + '</div>' +
            '</li>'
        );
        $item.on('hover:enter', function () {
            Lampa.Activity.push({
                url: '',
                title: Lampa.Lang.translate('trakt_v3_screen_title'),
                component: COMPONENT,
                page: 1
            });
        });
        $list.append($item);
    }

    // ────────────────────────────────────────────────────────────────────
    // Settings
    // ────────────────────────────────────────────────────────────────────
    function registerSettings() {
        if (!window.Lampa || !Lampa.SettingsApi) return;
        try {
            // Регистрируем свой раздел Settings (не пересекается с trakt_by_LME).
            if (typeof Lampa.SettingsApi.addComponent === 'function') {
                Lampa.SettingsApi.addComponent({
                    component: SETTINGS_COMPONENT,
                    name: 'Trakt v3',
                    icon: ICON()
                });
            }

            // Параметр: URL сервера. При сохранении — проверка через /api/health.
            // values:{} обязательно — Lampa дёргает Params.select(name, values, default)
            // даже для type:'input', и без values падает с TypeError.
            Lampa.SettingsApi.addParam({
                component: SETTINGS_COMPONENT,
                param: {
                    name: STORAGE_SERVER_URL,
                    type: 'input',
                    values: {},
                    'default': DEFAULT_SERVER_URL,
                    placeholder: DEFAULT_SERVER_URL
                },
                field: {
                    name: Lampa.Lang.translate('trakt_v3_setting_url'),
                    description: Lampa.Lang.translate('trakt_v3_setting_url_descr')
                },
                onChange: function (newValue) {
                    var url = String(newValue || '').trim();
                    if (!url) { setServerUrl(DEFAULT_SERVER_URL); return; }
                    // Lampa уже сохранила значение к моменту onChange; делаем
                    // тестовый запрос и при ошибке откатываем к предыдущему.
                    var prev = getServerUrl();
                    setServerUrl(url);
                    serverGet('/api/health').then(function (resp) {
                        if (resp && resp.ok) {
                            notify(Lampa.Lang.translate('trakt_v3_url_ok'));
                        } else {
                            setServerUrl(prev);
                            notify(Lampa.Lang.translate('trakt_v3_url_fail'));
                        }
                    }).catch(function () {
                        setServerUrl(prev);
                        notify(Lampa.Lang.translate('trakt_v3_url_fail'));
                    });
                }
            });

            // Кнопка: Принудительная синхронизация
            Lampa.SettingsApi.addParam({
                component: SETTINGS_COMPONENT,
                param: { name: 'trakt_v3_force_resync', type: 'button' },
                field: {
                    name: Lampa.Lang.translate('trakt_v3_setting_force'),
                    description: Lampa.Lang.translate('trakt_v3_setting_force_descr')
                },
                onChange: function () {
                    serverPost('/api/sync/force').then(function (resp) {
                        if (resp && (resp.ok || resp.skipped)) {
                            notify(Lampa.Lang.translate('trakt_v3_force_ok'));
                        } else {
                            notify(Lampa.Lang.translate('trakt_v3_force_fail') + ': ' + ((resp && resp.error) || 'unknown'));
                        }
                    }).catch(function () {
                        notify(Lampa.Lang.translate('trakt_v3_force_fail'));
                    });
                }
            });

            try { console.log('[trakt_v3] settings registered (component=' + SETTINGS_COMPONENT + ')'); } catch (_) {}
        } catch (e) {
            try { console.warn('[trakt_v3] registerSettings failed', e); } catch (_) {}
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Bootstrap
    // ────────────────────────────────────────────────────────────────────
    function start() {
        if (window.trakt_v3_started) return;
        window.trakt_v3_started = true;

        registerLang();
        Lampa.Component.add(COMPONENT, MainComponent);
        registerCardSidebar();
        registerSettings();

        installHoverLongHook();
        installFullCardHook();
        installTimelineUpdateHook();
        installCardBuildHook();
        // Загружаем легковесную карту состояний для overlay-значков B1.
        fetchCardStates();

        // Debug-handle для DevTools: window.trakt_v3.STATES_INDEX, .processAllCards(),
        // .fetchCardStates(). Не используется в проде, только для диагностики.
        try {
            window.trakt_v3 = {
                version: VERSION,
                get STATES_INDEX() { return STATES_INDEX; },
                get CARDS_INDEX() { return CARDS_INDEX; },
                processAllCards: processAllCards,
                fetchCardStates: fetchCardStates,
                computeProgressBar: computeProgressBar,
                lookupStateByCardEl: lookupStateByCardEl
            };
        } catch (_) {}

        // Прелоад: тянем /api/folders в фон, чтобы CARDS_INDEX и CUSTOM_LISTS были
        // готовы к моменту первого long-tap'а (даже если юзер не открыл наш Activity).
        serverGet('/api/folders').then(function (folders) {
            writeCachedFolders(folders);
            ingestFoldersResponse(folders);
            registerCustomListsInSidebar();
        }).catch(function (err) {
            try { console.warn('[trakt_v3] preload /api/folders failed', err); } catch (_) {}
            var cached = readCachedFolders();
            if (cached) {
                ingestFoldersResponse(cached);
                registerCustomListsInSidebar();
            }
        });

        if (window.appready) {
            injectMenuItem();
        } else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') injectMenuItem();
            });
        }

        try { console.log('[trakt_v3] started, version', VERSION); } catch (_) {}
    }

    function whenLampaReady() {
        if (window.Lampa && Lampa.Activity && Lampa.Component && Lampa.Listener) {
            start();
            return;
        }
        var iv = setInterval(function () {
            if (window.Lampa && Lampa.Activity && Lampa.Component && Lampa.Listener) {
                clearInterval(iv);
                start();
            }
        }, 200);
    }

    whenLampaReady();
})();
