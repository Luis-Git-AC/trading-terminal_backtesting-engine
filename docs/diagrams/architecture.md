# Arquitectura — diagramas

Complementa la vista general del [README](../../README.md). Dos diagramas: los procesos y sus
dependencias, y la secuencia completa de lanzar un backtest de punta a punta.

## Procesos y flujo de datos

```mermaid
flowchart LR
  subgraph EX[Bitget]
    REST[REST publico\nhistory-candles]
    WS[WebSocket publico\ncandle channel]
  end

  subgraph BE[Backend — un artefacto, tres roles]
    API[api\nExpress 5, HTTP + SSE]
    ING[ingestor\nWS client + gap filler]
    WK[worker\nBullMQ, motor de backtest]
    RD[(Redis\ncolas + cache + pub/sub)]
    PG[(PostgreSQL + TimescaleDB\nhypertable OHLCV)]
  end

  FE[frontend\nReact 19 + Vite, SPA estatica]

  REST -->|backfill paginado| ING
  WS -->|velas cerradas| ING
  ING --> PG
  ING -->|publish tick| RD
  FE -->|HTTP / TanStack Query| API
  FE -->|SSE progreso + ticks| API
  API --> PG
  API --> RD
  API -->|enqueue backtest| RD
  RD --> WK
  WK --> PG
  WK -->|publish progreso| RD
  RD -->|subscribe| API
```

`api`, `ingestor` y `worker` son el mismo artefacto de Node arrancado con un `START_MODE` distinto
(`api` \| `ingestor` \| `worker`) — mismo código, mismas migraciones, tres procesos independientes.
El porqué de esta separación está en el README, sección "¿Por qué un worker separado?".

## Lanzar un backtest, de punta a punta

```mermaid
sequenceDiagram
  participant FE as Frontend
  participant API as API
  participant Q as Redis
  participant WK as Worker
  participant DB as Postgres

  FE->>API: POST /api/backtests {strategy, params, range, seed}
  API->>API: valida con Zod, calcula paramsHash
  API->>DB: INSERT backtest_runs (status=queued)
  API->>Q: add job {runId}
  API-->>FE: 202 {runId}
  FE->>API: GET /api/backtests/:id/stream (SSE)
  Note over API,Q: la ruta se suscribe al canal ANTES de<br/>confiar en el estado leido (evita perder<br/>el "done" si el run termina en esa ventana)
  WK->>Q: consume job
  WK->>DB: SELECT velas del rango (por chunks)
  WK->>WK: engine.run(candles, strategy, params, seed)
  loop cada N velas
    WK->>Q: publish progreso {pct, barsDone}
    Q-->>API: pub/sub
    API-->>FE: event: progress
  end
  WK->>DB: INSERT trades, equity, metrics, status completed
  WK->>Q: publish {done}
  API-->>FE: event: done
  FE->>API: GET /api/backtests/:id
```

La nota sobre la suscripción no es cosmética: es un defecto real que se coló hasta el primer
`push` a GitHub Actions (ver "Determinismo y garantías" en el README) y que solo se manifestaba
bajo la contención de CPU de un runner de CI, nunca en local.
