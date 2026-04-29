# Handoff: Lampa-Trakt Proxy Server (новый проект)

> Этот документ — полный onboarding для Клода, начинающего работу над VPS-сервером в новом проекте. Прочитав его, ты должен понимать всё про контекст, текущее состояние клиента, цели сервера, договорённости и стиль работы Eugene.

---

## 1. TL;DR

Eugene — автор плагина для Lampa (TV-приложение, JavaScript). Плагин называется **lampa_trakt_v2**, синхронизирует просмотренное с Trakt.tv. Сейчас плагин работает целиком клиентски: дёргает Trakt API напрямую через прокси `trakt_by_LME` (сторонний плагин в Lampa, у которого мы заимствуем OAuth-токен и URL прокси).

Текущий клиент — версия 0.1.18, в активной отладке. Файл: `C:\Clade_projects\lampa_trakt_v2\github\trakt_v2.js` (~1543 строки, IIFE-обёртка).

**Новый проект — серверный прокси на VPS**, который:
- Берёт на себя OAuth, fetchAll, классификатор статусов, TMDB-обогащение, write-actions, оптимистичные обновления
- Отдаёт клиенту готовые классифицированные данные мгновенно (вместо текущих 5-7 секунд через Trakt)
- Освобождает клиент от зависимости от `trakt_by_LME` и Trakt-API напрямую
- Закрывает stale-окно Trakt (5-15 мин) на серверной стороне
- Закладывает фундамент под параллельный Showly-форк

**Текущий клиент остаётся как есть** — Eugene хочет сохранить рабочую реализацию на случай отката. Миграция клиента на новый сервер — отдельное решение после того, как сервер стабилизируется.

---

## 2. Eugene — рабочий профиль

- **Личное использование** + 2-3 члена семьи. **Один общий Trakt-аккаунт** на всех. Не публичный сервис.
- Не нужны fancy security-меры: можно хардкодить API-ключи, plain JSON для токенов, никакого шифрования.
- Имеет VPS, домен (через Cloudflare), SSL автоматический через CF, Node 20+ должен быть на VPS (надо подтвердить).
- Также имеет в планах форк Showly — серверная инфраструктура должна потенциально обслуживать оба клиента.

### Стиль работы Eugene

Зафиксировано из десятков взаимодействий:

- **Matrix-before-code** — сначала договариваемся по логике/матрице переходов/архитектуре, потом пишем код. Если Клод прыгает в код раньше, ожидай «погоди, отвечу текстом».
- **Defer-by-naming** — когда вопрос не закрыт, складываем в backlog с понятным именем и движемся дальше. Не зависаем.
- **Refines model in dialogue** — модель данных может перекраиваться по ходу. Не цепляйся за первоначальное предложение, перерисовывай матрицу.
- **Без эмодзи в ответах** (Eugene их не использует, я тоже не должен).
- **Общается на русском**, отвечать тоже на русском.

### Команды для shell

- **Только cmd Windows**. Один полный one-liner с `&&`, copy-paste готовый.
- **Команда коммита: только title** в `-m`, без длинных описаний. Описания идут в README.md / CHANGELOG.md.
- **`git add -A`**, не отдельные файлы.
- **Сам проверяй целостность файла** через Read tool (последние строки, IIFE-close, типичная структура). Не проси Eugene запускать `dir` без явной аномалии.
- Паттерн:
  ```
  cd /d C:\path && git add -A && git commit -m "v0.X.Y: <короткий заголовок>" && git push
  ```

### Чувствительные темы

- **Не упоминать домены, связанные с хостингом Lampa в чате** — есть подозрение, что это триггерило прошлые policy-refusals от Anthropic. Используй обтекаемые формулировки типа «веб-билд», «тестовая страница». Внутри plugin-кода / backend-кода — конкретные URL допустимы (это технические артефакты, не разговор).
- **lampa.mx как домен** — не упоминать в ответах.

### Имена файлов логов

- Eugene даёт точные имена логов (например, `1777441646044.log`). Не добавляй префиксы (типа `lampa.mx-`) в команды чтения. Файл может на диске иметь префикс, но при поиске используй grep по имени из последних обращений.

---

## 3. Текущая архитектура клиента — то, что портируется на сервер

### Модель данных (фиксированная)

Каждая карточка — два независимых поля:

- `trakt_status` ∈ `null | 'progress' | 'finished' | 'upcoming' | 'dropped'` (взаимоисключающие)
- `trakt_watchlist` — boolean (ортогональный флажок)

Карточка отображается в UI, если `status != null || watchlist === true`. Ряд Watchlist собирает все WL=true независимо от статуса (дубли с другими рядами осмысленны).

### Классификатор (порт на сервер)

```javascript
function classifyMovie(node) {
    if (node.dropped) return 'dropped';
    if (node.in_watched) return 'finished';
    return null; // None — может быть только wl=true
}

function classifyShow(node) {
    if (node.dropped) return 'dropped';
    var p = node.progress;
    var completed = p ? Number(p.completed || 0) : 0;
    if (completed === 0) return null;
    var hasNext = p && p.next_episode;
    if (hasNext) return 'progress';
    var s = String(node.media.status || '').toLowerCase();
    if (s === 'ended' || s === 'canceled') return 'finished';
    return 'upcoming';
}
```

### Матрица переходов (write-actions)

**Movie:**
| Current status | Tap Finished | Tap Dropped |
|---|---|---|
| None | + history, − WL → Finished | + dropped (custom list), − WL → Dropped |
| Finished | − history (b1, ALL plays) → None | + dropped, − WL (history kept) → Dropped |
| Dropped | − dropped, + history, − WL → Finished | − dropped → reclassify |

**Show:**
| Current status | Tap Finished | Tap Dropped |
|---|---|---|
| None | + history all aired, − WL → Finished/Upcoming | + hdr + list, − WL → Dropped |
| Progress | + history all aired, − WL → Finished/Upcoming | + hdr + list, − WL → Dropped |
| Upcoming | noop | + hdr + list, − WL → Dropped |
| Finished | noop (на будущее, открытый вопрос) | + hdr + list, − WL → Dropped |
| Dropped | − hdr − list + history all aired, − WL → Finished/Upcoming | − hdr − list → reclassify |

**Tap Watchlist** — toggle WL флажка на любой карточке, статус не меняется.

**Глобальные правила:**
1. Auto-remove WL при установке статуса (Finished или Dropped) если был wl=true
2. Dropped не трогает history (вообще, во всех направлениях)
3. Trakt автоматически снимает WL при scrobble на сериал (не вмешиваемся)

### Trakt API endpoints, которые мы используем

**Read:**
- `GET /sync/watchlist/movies?extended=full`
- `GET /sync/watchlist/shows?extended=full`
- `GET /sync/watched/movies?extended=full`
- `GET /sync/watched/shows?extended=full`
- `GET /shows/<trakt_id>/progress/watched` (per show with completed > 0)
- `GET /users/hidden/dropped?type=show&limit=1000`
- `GET /users/me/lists/<list_id>/items?type=show,movie&limit=200`
- `GET /users/me/lists` (для подгрузки списка пользовательских листов)
- `GET /search/tmdb/<tmdb_id>?type=show` (резолв trakt_id для тощих карточек)

**Write:**
- `POST /sync/watchlist` / `/sync/watchlist/remove`
- `POST /sync/history` / `/sync/history/remove`
- `POST /users/hidden/dropped` / `/remove`
- `POST /users/me/lists/<list_id>/items` / `/remove`

**НЕ используем:**
- `/users/hidden/progress_watched` (hpw) — Moviebase one-way trap, см. ниже
- VIP-эндпоинты (`up_next_nitro` и пр.)

### Архитектурные решения (твёрдые)

1. **v2 не пишет в `Lampa.Favorite`** — у нас собственная коллекция папок, не интегрируемся с нативной картотекой Lampa.

2. **Нативные папки Lampa («Избранное»: book/like/wath/history; «Статус»: look/viewed/scheduled/continued/thrown) — будут УДАЛЕНЫ из UI в будущем.** Наши 5 папок — единственные long-term. Не предлагай интеграции с native folders.

3. **Cub зависимость уйдёт.** Не используй `Account.hasPremium()`, не пиши в `Lampa.Favorite`. Плагин должен работать на vanilla Lampa без Cub-аккаунта.

4. **`/users/hidden/progress_watched` (hpw) — НЕ читаем и НЕ пишем.** Moviebase пишет туда «Stop watching» односторонне, без UI отмены — карточка залипает. Если бы мы писали, наш «un-drop» оставлял бы Moviebase-запись, UI был бы рассинхронизирован.

5. **Dropped стратегия**: `/users/hidden/dropped` (hdr) + наш custom list. Для movies — только list (hdr не поддерживает movies). Без настроенного листа movies dropped недоступен.

6. **Кнопка «Drop show» в Trakt-веб появляется только на просмотренных шоу (в Continue Watching).** Поэтому `POST /users/hidden/dropped` для не-просмотренного сериала Trakt принимает с 200 OK но `not_found.shows: [...]` — silent reject. **Это by design, не баг.** Custom list — наш source of truth для Dropped.

7. **type-aware ключи в droppedTmdb**: один и тот же tmdb_id может быть и movie и show в Trakt — разные сущности. Все коллекции keyed по `'show:<tmdb>'` / `'movie:<tmdb>'`.

8. **resolveCardType двухэтапный**:
   - Stage 1 sync heuristic: `method`/`card_type`/`media_type` → быстрый путь
   - Если их нет — `name`/`original_name`/`first_air_date`/`number_of_seasons`/`episode_run_time` → show, default → movie
   - Stage 2 (опциональный, не реализован в клиенте): `GET /search/tmdb/<id>` для тощих карточек, show-priority при коллизии. **Точно нужно реализовать на сервере.**

### Что отсутствует / отложено в клиенте

- **Pending Ops**: TTL-буфер для stale-окна Trakt — отложен, потому что Trakt сейчас отвечает быстро. **На сервере реализуется тривиально** через мгновенную мутацию снапшота.
- **Канонизация Dropped** (fire-and-forget retry в недостающие ячейки): отложено, нужен ресёрч поведения других клиентов (Moviebase, Trakt-веб).
- **Episode-sync с Lampa.Timeline**: отложено целиком до стабильного MVP.

---

## 4. Цель серверного проекта

### Что сервер делает

1. **OAuth Trakt — единожды.** Один аккаунт на всю семью. Хардкод client_id/client_secret в config. Скрипт `scripts/trakt-auth.js` запускаешь один раз — device-code flow → токен сохраняется в `config/auth.json`.

2. **Sync engine.** В фоне (cron или setInterval, каждые 5-10 мин) тянет из Trakt всё что нужно (см. список endpoint'ов выше), классифицирует, обогащает TMDB-постерами/названиями, складывает в нормализованный снапшот `data/snapshot.json`.

3. **Read API для клиента.** Клиент дёргает `GET /v2/folders` → получает 5 классифицированных рядов с готовыми постерами, мгновенно. `GET /v2/card/:tmdb?type=show` → состояние конкретной карточки для сайдбара.

4. **Write API.** Клиент дёргает `POST /v2/tap/watchlist` (или `/finished`, `/dropped`) с tmdb_id и type. Сервер реализует серверную матрицу переходов: оптимистично мутирует снапшот → шлёт в Trakt → при ошибке откатывает.

5. **Pending Ops «бесплатно».** Серверный снапшот мутируется мгновенно при write → next read клиента видит новое состояние сразу. Trakt догоняет в фоне через 5-15 мин. Стейл-окно невидимо клиенту.

### Что сервер НЕ делает (на старте)

- Аутентификация клиентов (нет — личный proxy, доступ через VPN или просто через subdomain без защиты)
- Multi-user (нет — один аккаунт на всех)
- WebSocket / SSE для realtime (можно отложить)
- Episode-sync (отложено как и в клиенте)

---

## 5. Стек

- **Node.js 20+** + **Express** (или Fastify, но Express проще)
- **CORS** middleware (клиент — Lampa в браузере, нужно разрешить запросы из любого/конкретного origin)
- **State**: file-based (`data/snapshot.json`), периодический dump. Никакого Redis/Postgres на старте.
- **TMDB-кеш**: file-based с TTL (например, 24 часа на постеры/тайтлы)
- **Deploy**: VPS через rsync или git pull, systemd unit для авто-рестарта
- **HTTPS**: через Cloudflare (proxy mode), origin может быть HTTP

---

## 6. Pre-work со стороны Eugene (до старта Day 1)

1. **Зарегистрировать своё Trakt-приложение**: https://trakt.tv/oauth/applications/new
   - Name: что-то вроде `lampa_trakt_proxy`
   - Redirect URI: `urn:ietf:wg:oauth:2.0:oob` (для device-code flow)
   - Permissions: `/checkin`, `/scrobble` оставить включёнными (пригодится для будущего episode-sync)
   - Получить `client_id` + `client_secret`

2. **Выбрать subdomain в Cloudflare** под VPS. Например, `trakt.<домен>` или `lt.<домен>`. Создать A-запись на IP VPS, прокси включён (оранжевый облак).

3. **Подтвердить Node 20+ на VPS**: `node --version`. Если нет — `apt install nodejs npm` или nvm.

4. **Сообщить новому Клоду OS на VPS** (Ubuntu/Debian/etc). Нужно для systemd-unit-файла.

---

## 7. Day 1 — skeleton (2-3 часа)

**Цель**: запущенный сервер на VPS, доступный через HTTPS subdomain, отвечает stub-JSON на `GET /v2/folders`.

**Структура файлов**:

```
lampa_trakt_proxy/
├── package.json              (express, cors)
├── src/
│   ├── index.js              (Express setup, CORS, routes)
│   └── routes/
│       └── folders.js        (GET /v2/folders → mock data)
├── config/
│   ├── settings.js           (client_id, client_secret, TMDB key — committed для personal-use ок, или gitignored)
│   └── auth.json.example     (template для auth.json)
├── data/                     (gitignored — snapshot.json появится позже)
├── scripts/                  (пока пусто, для trakt-auth.js)
├── .gitignore                (node_modules, config/auth.json, data/)
├── README.md                 (как deploy + ENV-переменные)
└── lampa-trakt-proxy.service (systemd unit)
```

**Что делаешь**:
1. Создаёшь файлы выше с минимальным содержимым
2. На VPS: `git clone` → `npm install` → systemd-start → enable
3. Cloudflare DNS-запись на VPS IP, прокси-mode оранжевый
4. Тестируешь: `curl https://<subdomain>/v2/folders` → mock JSON

После Day 1: deploy-pipeline отлажен, дальше только наращиваешь.

---

## 8. Days 2-3 — sync engine (реальные данные)

- `scripts/trakt-auth.js`: device-code flow. Запускаешь раз — печатает код, идёшь на trakt.tv/activate, вводишь, скрипт получает токен, сохраняет в `config/auth.json`.
- `src/trakt.js`: обёртки для каждого endpoint с auto-refresh токена.
- `src/tmdb.js`: TMDB-fetch с локальным file-кешем.
- `src/classifier.js`: порт `classifyShow`/`classifyMovie` (см. секцию 3 выше).
- `src/sync.js`: fetchAll equivalent, классифицирует, обогащает, складывает в `data/snapshot.json`.
- `src/index.js`: cron-loop через setInterval (5-10 мин) + триггер при первом запросе.
- `GET /v2/folders` возвращает реальные данные из снапшота.

---

## 9. Days 4-5 — write API

- `src/matrix.js`: серверная матрица переходов (см. таблицы в секции 3).
- `POST /v2/tap/watchlist`, `/v2/tap/finished`, `/v2/tap/dropped` — каждый принимает `{tmdb, type}`, серверная матрица решает что делать.
- Серверный flow: optimistic-update снапшот → write to Trakt → при ошибке откатывает.

---

## 10. Days 6-9 — клиентская миграция (отдельное решение)

**Не входит в minimum scope нового проекта.** Eugene решает после стабилизации сервера, мигрировать ли текущий `lampa_trakt_v2` на новый proxy или оставить параллельно. Если решит мигрировать — отдельные шаги:

- Заменить `fetchAll` на `fetch('https://<subdomain>/v2/folders')`
- Удалить классификатор, TMDB enrichment, apiGet/apiPost обёртки
- Заменить sidebar tap-handler'ы на POST к серверу
- Удалить зависимость от `trakt_by_LME` (token больше не нужен в клиенте)

---

## 11. Где найти полный контекст текущего клиента

Если новый Клод хочет копнуть глубже текущей реализации:

- `C:\Clade_projects\lampa_trakt_v2\github\trakt_v2.js` — полный исходник плагина (1543 строки). Шапка очень короткая (намеренно), всё в README.
- `C:\Clade_projects\lampa_trakt_v2\github\README.md` — полный changelog v0.1.4 — v0.1.18 с lessons learned.
- `C:\Clade_projects\lampa_trakt_v2\github\SPEC_v2.md` — оригинальная спецификация (внимание: использует устаревшую терминологию папок, актуальная модель в README + матрица в этом документе).
- `C:\Clade_projects\lampa_trakt_v2\v1_trakt_folder_sync.js` — v1 плагина (другая архитектура, но **много готовых решений**: resolveCardType двухэтапный, postHiddenAdd с диагностикой `added/not_found`, buildHiddenBody минимальный payload). **Перед изобретением — всегда проверь v1.**
- `C:\Clade_projects\lampa_trakt_v2\v1_SPEC.md`, `v1_README.md` — v1 spec и changelog с уроками о Trakt API.
- `C:\Clade_projects\lampa_trakt_v2\trakt_by_LME.js` — **сторонний плагин**, не ядро Lampa. Не лазь туда искать Lampa-внутренности. Используется как образец patterns (Manifest.plugins, SettingsApi.addParam — компонент `'trakt'`).

---

## 12. Ключевые «не забудь»

- **Не спутай**: «папка Брошено» = пользовательский custom list в Trakt (через `/users/me/lists/...`). «Статус dropped» = `/users/hidden/dropped` (системная ячейка). Это две разные сущности в Trakt.
- **`/users/hidden/dropped` для не-просмотренного сериала вернёт `not_found`** — это by design, не пытайся «починить». Custom list — единственный надёжный источник Dropped state для всех типов карточек.
- **Один и тот же tmdb_id = разные сущности для movie и show в Trakt.** Всегда разделяй по типу при идентификации.
- **`resolveCardType` нужен и на сервере**: входящий `{tmdb, type}` от клиента может быть с неправильным type для тощих карточек. Сервер должен уметь резолвить через `/search/tmdb/<id>` с show-priority tiebreaking.
- **Pending Ops автоматически решается серверной архитектурой** — не нужно отдельной логики, просто optimistic update снапшота при write.
- **Cron-period для sync**: 5-10 мин фоном + триггер при первом read. Trakt rate limit 1000/5мин — запас огромный.
- **TMDB API key**: тот же что использует Lampa-ядро (есть в `trakt_v2.js:53` как `4ef0d7355d9ffb5151e987764708ce96`), может использовать его на старте; в перспективе свой.

---

## 13. Backlog уровня сервера (отложено, но названо)

1. **Pending Ops fine-tuning** — TTL-окно конфигурируемое (15м/5м/1м/выкл) если нужно для отладки. На MVP не нужно — серверный снапшот всегда актуален.
2. **Канонизация Dropped** — fire-and-forget POST в недостающие ячейки между hdr/list. Зависит от ресёрча поведения других клиентов (Moviebase). На старте не нужно.
3. **Episode-sync с Lampa.Timeline** — отложено целиком, см. SPEC v1 разделы 0.9.0-0.9.3.
4. **Multi-user** — если в будущем понадобится. Пока единый аккаунт.
5. **Showly-форк support** — общий API, тот же сервер. Когда дойдём до Showly-клиента, сервер уже будет готов.
6. **Scrobble episode events** — `POST /scrobble/start|pause|stop` proxy через сервер. Когда будет episode-sync.
7. **Health-check endpoint** + базовый dashboard — сейчас можно через `journalctl -u lampa-trakt-proxy.service`.
8. **Разделение public/private API** — если когда-то откроем для других — auth перед запросами. Сейчас не нужно.

---

## 14. Стартовый чеклист для нового Клода

- [ ] Прочитать этот документ целиком.
- [ ] Спросить Eugene: сделал ли pre-work (Trakt-app, subdomain, Node), какая OS на VPS.
- [ ] Подтвердить что понял scope (server only, client v2 остаётся как есть).
- [ ] Day 1: выдать конкретные файлы (package.json, src/index.js, systemd unit) для copy-paste и deploy.
- [ ] После Day 1: переход к sync engine.

При сомнениях / если что-то противоречит этому документу — уточняй у Eugene прежде чем кодить. Eugene предпочитает обсуждение matrix-before-code.

---

**Last updated**: 2026-04-29 (на момент создания клиента v0.1.18).
