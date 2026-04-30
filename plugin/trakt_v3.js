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

    var VERSION = '0.1.4';
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
    var episodesSynced = {}; // tmdb → true чтобы не пушить повторно в одной сессии

    function applyEpisodesToTimeline(originalName, episodes) {
        if (!originalName || !Array.isArray(episodes)) return 0;
        if (!Lampa.Timeline || typeof Lampa.Timeline.update !== 'function') return 0;
        var pushed = 0;
        for (var i = 0; i < episodes.length; i++) {
            var e = episodes[i];
            if (!e || !e.watched) continue;
            var hash = episodeHash(originalName, e.season, e.episode);
            if (!hash) continue;
            try {
                Lampa.Timeline.update({
                    hash: hash,
                    percent: 95,
                    time: 0,
                    duration: 0,
                    profile: 0
                });
                pushed++;
            } catch (err) {
                try { console.warn('[trakt_v3] Timeline.update failed', err); } catch (_) {}
            }
        }
        return pushed;
    }

    function syncEpisodesForCard(cardData) {
        if (!cardData) return;
        var tmdb = cardData.id || (cardData.ids && cardData.ids.tmdb);
        var method = cardData.method || cardData.card_type;
        if (!tmdb || (method !== 'tv')) return; // только для shows
        if (episodesSynced[tmdb]) return;        // уже синкали в этой сессии
        episodesSynced[tmdb] = true;
        serverGet('/api/show/' + tmdb + '/episodes')
            .then(function (resp) {
                if (!resp || !resp.ok) return;
                var pushed = applyEpisodesToTimeline(resp.original_name || cardData.original_name, resp.episodes || []);
                try { console.log('[trakt_v3] episodes synced for tmdb=' + tmdb + ', pushed=' + pushed); } catch (_) {}
            })
            .catch(function (err) {
                try { console.warn('[trakt_v3] episodes sync failed for ' + tmdb, err); } catch (_) {}
                // Сбрасываем флаг — попробуем ещё раз при следующем open
                episodesSynced[tmdb] = false;
            });
    }

    // Hook на open full-карточки. Lampa шлёт event 'full' с типом 'complite'
    // когда карточка собрана и видна юзеру.
    function installFullCardHook() {
        if (!window.Lampa || !Lampa.Listener) return;
        if (window.__trakt_v3_full_hook_installed) return;
        window.__trakt_v3_full_hook_installed = true;
        Lampa.Listener.follow('full', function (e) {
            if (!e) return;
            if (e.type === 'complite' || e.type === 'complete') {
                var data = e.data && (e.data.movie || e.data);
                if (data) syncEpisodesForCard(data);
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
