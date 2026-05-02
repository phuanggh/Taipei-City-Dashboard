# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Taipei City Dashboard 2.0 — a public data visualization platform by Taipei Urban Intelligence Center (TUIC). Three sub-projects share a Docker Compose network (`br_dashboard`):

| Sub-project | Stack | Directory |
|---|---|---|
| **FE** | Vue 3 + Vite + Pinia + Mapbox GL | `Taipei-City-Dashboard-FE/` |
| **BE** | Go 1.24 + Gin + GORM + LangChainGo | `Taipei-City-Dashboard-BE/` |
| **DE** | Python Airflow DAGs | `Taipei-City-Dashboard-DE/` |

---

## Commands

### Infrastructure (start this first)
```bash
# from repo root
docker compose -f docker/docker-compose-db.yaml up -d   # postgres-data, postgres-manager, redis, qdrant, pgadmin
docker compose -f docker/docker-compose.yaml up -d      # nginx, dashboard-fe, dashboard-be
```

### Frontend
```bash
cd Taipei-City-Dashboard-FE
npm install
npm run dev        # dev server (Vite)
npm run build      # runs eslint --fix then vite build
npm run lint       # eslint --fix
```

### Backend
```bash
cd Taipei-City-Dashboard-BE
go run main.go             # start server (reads env from docker/.env or OS env)
go build -o TaipeiCityDashboardBE .
go test ./...              # run all tests
go vet ./...               # static analysis
```

Build the dev Docker image (required for running BE in Docker with ONNX runtime):
```bash
docker build --target dev -t dashboard-be-dev:latest Taipei-City-Dashboard-BE/
```

### Data Engineering
```bash
# DAG development runs inside Airflow containers (docker-compose in Taipei-City-Dashboard-DE/docker/)
cd Taipei-City-Dashboard-DE
docker compose up -d
```

---

## Architecture

### Frontend (`Taipei-City-Dashboard-FE/src/`)

**Pinia stores** manage all state:
- `contentStore` — fetches dashboards and components from BE, manages current view
- `authStore` — JWT auth, TaipeiPass SSO
- `chatStore` — AI chat history (persisted to sessionStorage), triggers RAG vector search
- `mapStore` — Mapbox map state and layers
- `dialogStore` — modal/dialog open states

**Views**: `DashboardView`, `MapView`, `ComponentView`, `ComponentInfoView`, `EmbedView`

The chat feature in `chatStore` calls two separate endpoints:
1. `POST /api/v1/vector/component` — semantic search (Qdrant RAG) to find relevant dashboard components
2. `POST /api/v1/ai/chat/twai` — TWCC AI for conversation (supports streaming SSE)

### Backend (`Taipei-City-Dashboard-BE/`)

**Two PostgreSQL databases**:
- `DBDashboard` (`postgres-data`) — all city statistical/GIS data tables populated by DE
- `DBManager` (`postgres-manager`) — users, roles, dashboards, components config, chat logs, AI logs

**Route groups** (all under `/api/v1/`): `auth`, `user`, `component`, `dashboard`, `issue`, `incident`, `contributor`, `chatlog`, `vector`, `ai`

**AI subsystem** (`app/services/ai/`):
- `ai_service.go` — `aiSession` orchestrates the tool-calling loop (up to 5 iterations), retry logic, streaming heartbeats, and DB logging
- `tools/registry.go` — register new tools here with `Register("tool_name", func)`. Current tools: `get_current_time`, `get_population_summary`
- `providers/twcc/` — LangChainGo wrapper for TWCC AI Foundry (llama3.3-ffm-70b-16k-chat)
- Concurrency controlled by `aiSemaphore` (limit: `TWCC_MAX_CONCURRENT`)

**Embedding / vector search** (`app/models/qdrant.go`):
- Local ONNX E5 model (`/opt/lm_model/onnx-e5/`) generates 768-dim embeddings via ONNX Runtime
- Embeddings stored in Qdrant collection `query_charts`
- `GenVector(text)` → mean-pool + L2-normalize → query Qdrant

**Adding a new AI tool**:
1. Write `func MyTool(ctx context.Context, args string) (string, error)` in `app/services/ai/tools/`
2. Call `Register("my_tool", MyTool)` in the `init()` of `registry.go`
3. The frontend passes the tool definition in the `tools` array when calling `/api/v1/ai/chat/twai`

### Data Engineering (`Taipei-City-Dashboard-DE/dags/`)

Each dataset is a self-contained folder:
```
dags/proj_city_dashboard/{DAG_ID}/
├── {DAG_ID}.py        # ETL logic, single function _DAG_ID(**kwargs)
└── job_config.json    # schedule, table names, metadata
```

DAGs use `CommonDag` from `operators/common_pipeline.py` which auto-routes tasks to Airflow queues based on schedule frequency (`realtime` / `default` / `heavy`).

ETL pattern: each `_DAG_ID` function receives `kwargs` with `ready_data_db_uri`, `dag_infos`; uses `utils/extract_stage.py`, `utils/transform_*.py`, `utils/load_stage.py`.

---

## Environment Configuration

All env vars live in `docker/.env`. Key groups:
- **Frontend**: `VITE_API_URL`, `VITE_MAPBOXTOKEN`, `VITE_MAPBOXTILE`
- **Backend DB**: `DB_DASHBOARD_*`, `DB_MANAGER_*`
- **AI**: `TWCC_API_URL`, `TWCC_API_KEY`, `TWCC_MODEL`, `TWCC_MAX_CONCURRENT`
- **Vector**: `QDRANT_URL`, `QDRANT_COLLECTION`, `QDRANT_API_KEY`, `LM_MODEL_PATH`

The BE reads all config via `global/global.go` at startup from OS env.

---

## Key Conventions

- API version prefix: `/api/v1/` (set in `global/consts.go` as `VERSION = "v1"`)
- Middleware chain for protected routes: `ValidateJWT` → `IsLoggedIn()` → `IsSysAdm()` (escalating)
- BE uses GORM with raw SQL for complex queries; simple CRUD via model methods in `app/models/`
- FE uses `router/axios.js` (configured Axios instance) for all API calls — not raw `fetch`
- Chat logs (`chat_logs` table in Manager DB) are separate from AI logs (`ai_chat_logs` table)
