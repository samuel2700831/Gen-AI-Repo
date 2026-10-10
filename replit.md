# Ad Campaign Performance Analyzer

A CSV-powered marketing dashboard comparing campaign spend, clicks, conversions, and ROI across Facebook, Instagram, Pinterest, and Twitter.

## Run & Operate

- `artifacts/campaign-analyzer: web` — managed dashboard preview workflow
- Streamlit preview starts from `artifacts/campaign-analyzer/app.py`.
- `uv run streamlit run artifacts/campaign-analyzer/app.py --server.port 5000` — run the dashboard locally.
- CSV processing uses pandas in the Streamlit session; uploaded data is not saved to a database.
- Required CSV columns: `date`, `campaign`, `channel`, `audience`, `goal`, `spend`, `clicks`, `conversions`. Optional: `revenue`. Dates default to YYYY-MM-DD; explicitly select MM/DD/YYYY, DD/MM/YYYY, YYYY/MM/DD, MM-DD-YYYY, or DD-MM-YYYY per upload. Every row must use the selected format with exact separators and padded month/day values.
- Monetary inputs must use one currency (USD). File limit: 5 MB / 50,000 rows.
- `uv run python -m unittest discover -s artifacts/campaign-analyzer -p 'test_*.py' -v` — run calculation, CSV import, and four-view Streamlit regressions. See `artifacts/campaign-analyzer/tests/README.md` for fixtures and coverage.
- `pnpm --filter @workspace/campaign-analyzer run test:browser` — native CSV upload/download regressions against the running Streamlit web workflow through the shared proxy.

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- Python 3.11, Streamlit, pandas, and Plotly for the campaign dashboard.
- The surrounding workspace also contains the shared pnpm/TypeScript API scaffold; this dashboard does not depend on that API or its database.

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

Four views: Overview, Platform Comparison, searchable Campaign Details, and Time Series. All use shared date, channel, audience, and goal filters. The initial dataset is explicitly labeled sample data.

## User preferences

- The user requires this dashboard to use Replit + Streamlit + pandas + Plotly, rather than React.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
