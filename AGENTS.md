# MapDistance — контекст для агента

Проект Димы (Dokki3). Версия `0.1.0`. Цель: на карте Москвы показывать зоны достижимости за N минут пешком / на метро / на машине (изохроны), UI в духе Apple Maps.

Язык общения с пользователем: русский. Код — по делу, без лишнего.

**Git — территория Димы.** Не делать `commit` / `push` / `pull` / ветки / amend / force push и прочие git-операции, пока он явно не попросит. Можно смотреть статус или историю только если это нужно для ответа на его вопрос. Не предлагать коммит без запроса.

## Стек

- Frontend: vanilla JS + MapLibre GL + OpenFreeMap (positron)
- Backend: Node.js (ESM) + Express
- Метро: свой граф в `server/metro.mjs` из OSM Overpass
- Пешком/машина: Valhalla в Docker (`ghcr.io/valhalla/valhalla-scripted`)
- Сборка/запуск целиком: Docker Compose
- Лицензия кода: MIT (`LICENSE`). Данные OSM — ODbL, нужна атрибуция.

Это **не** React/TypeScript. Платный Yandex Isochrone API не используем.

## Как запустить

Предпочтительно:

```bash
docker compose up -d --build
```

Приложение: http://localhost:8080  
Valhalla: http://localhost:8002  

Локально без Docker-приложения (Valhalla всё равно нужна):

```bash
npm ci
npm run start:dev   # Express :8787 + Vite :5173
```

`data/valhalla/` — локальный кэш тайлов (не в git). На чистой машине первый `compose up` скачает Moscow OSM с BBBike и соберёт граф (минуты–десятки минут). Повторный старт быстрый, если том уже есть.

## Архитектура

```
клик на карте → POST /api/isochrones {lat,lon,minutes}
  ├─ Valhalla /isochrone costing=pedestrian
  ├─ Valhalla /isochrone costing=auto
  └─ metroIsochrone(): walk→station + ride/transfer Dijkstra + union of residual walk circles
→ GeoJSON слои walk / metro / car, fill-opacity 0.25
```

Ключевые файлы:

| Путь | Назначение |
|---|---|
| `src/main.js`, `src/style.css`, `index.html` | UI карты, попап времени, слои |
| `server/index.mjs` | API + раздача `dist/` в проде |
| `server/metro.mjs` | граф метро, Дейкстра, полигон |
| `data/metro-overpass.json` | станции/линии OSM (в git) |
| `docker-compose.yml` | `valhalla` + `app` |
| `Dockerfile` | multi-stage: vite build → node serve |

## Важные решения и ограничения

- Метро ≠ весь ОТ: только subway из OSM. МЦК/МЦД/автобусы пока нет.
- Времена перегонов приближённые (константы скорости), не живое расписание.
- Машина без пробок.
- Зоны рисуются поверх друг друга разными цветами, не вычитаются.
- Автор коммитов — только Dokki; не оставлять `Co-authored-by: Cursor` (Cursor может дописать при обычном `git commit` — при необходимости переписывать через `commit-tree`).
- Ветку звать `main`. Remote: `https://github.com/Dokki3/MapDistance.git`.

## Что не коммитить

`node_modules/`, `dist/`, `data/*.pbf`, `data/valhalla/`, `.DS_Store`.

## Типичные следующие шаги (если спросят)

- МЦК/МЦД, более точные времена, «кто быстрее» heatmap
- README для людей
- Обновление `metro-overpass.json` через Overpass
- Не тащить платный Yandex Isoline без явной просьбы
