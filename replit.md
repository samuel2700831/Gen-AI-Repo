# Ad Campaign Performance Analyzer

A CSV-powered marketing dashboard comparing campaign spend, clicks, conversions, and ROI across Facebook, Instagram, Pinterest, and Twitter.

## Run & Operate

- `artifacts/campaign-analyzer: web` — managed dashboard preview workflow
- `pnpm --filter @workspace/campaign-analyzer run typecheck` — dashboard type check
- CSV processing is browser-only; uploads are session-only, not sent to the API server.
- Required CSV columns: `date` (YYYY-MM-DD), `campaign`, `channel`, `audience`, `goal`, `spend`, `clicks`, `conversions`. Optional: `revenue`.
- Monetary inputs must use one currency (USD). File limit: 5 MB / 50,000 rows.

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

Four views: Overview, Platform Comparison, searchable Campaign Details, and Time Series. All use shared date, channel, audience, and goal filters. The initial dataset is explicitly labeled sample data.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
