# lampa_trakt_v3

VPS-серверный буфер для синхронизации между Lampa и Trakt.tv. Сервер тянет данные из Trakt, классифицирует и обогащает TMDB, отдаёт клиенту мгновенно через JSON snapshot. В перспективе — общий backend для Lampa и Showly.

## Стек

- Node.js 20 + Fastify
- File-based JSON snapshot (через repo-абстракцию)
- Deploy: docker-compose
- HTTPS: Cloudflare proxy mode (origin HTTP)

## Структура

```
github/
├── server/                 # Fastify-сервер
│   ├── src/                # исходники
│   ├── package.json
│   └── Dockerfile
├── docs/                   # спецификация модели данных, API, матрица переходов
├── docker-compose.yml      # оркестрация
├── .env.example            # шаблон переменных окружения
└── .gitignore
```

`data/` и `config/auth.json` — gitignored, появляются на VPS как volumes.

## Day 1 — skeleton

Сервер отвечает на:

- `GET /api/health` — статус и uptime.
- `GET /api/folders` — заглушечная структура папок (модель Trakt 1:1).
- `GET /api/card/:tmdb?type=show` — заглушечное состояние карточки.

## Deploy на VPS

```bash
# на VPS
cd /opt
git clone <repo-url> lampa-trakt-v3
cd lampa-trakt-v3
cp .env.example .env
# отредактировать .env: TRAKT_CLIENT_ID, TRAKT_CLIENT_SECRET
docker compose up -d
docker compose logs -f server
```

## Проверка

```bash
curl http://localhost:8787/api/health
# {"ok":true,"version":"0.1.0",...}
```

## Roadmap

- Day 1: skeleton (текущий статус).
- Day 2-3: Trakt OAuth (device-code flow + auto-refresh), sync engine, snapshot.json, реальные данные в `/api/folders`.
- Day 4-5: write API (`POST /api/tap/*`) с optimistic-update снапшота.
- Subdomain: подключение через Cloudflare reverse proxy.
- Клиентский плагин Lampa v3 — отдельная сессия после стабилизации сервера.
