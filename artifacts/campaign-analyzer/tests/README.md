# Campaign analyzer regression checks

From the workspace root:

```sh
uv sync --locked
uv run python -m unittest discover -s artifacts/campaign-analyzer -p 'test_*.py' -v
```

From `artifacts/campaign-analyzer`, with the project dependencies installed:

```sh
python -m unittest discover -s . -p 'test_*.py' -v
```

The Python suite uses the standard `unittest` runner and Streamlit's `AppTest`.
No browser, API server, running Streamlit server, credentials, network access,
or database is needed. AppTest runs the real `app.py`, uses isolated session
state per test, and drives the actual date/multiselect/selectbox/button widgets.
Run all `test_*.py` modules; an exception or mismatch exits nonzero.

## Coverage and fixtures

- `test_search_export.py`: literal, case-insensitive search across all four
  metadata fields, whitespace/blank and no-match queries, search isolation from
  the other views and shared filters, plus the real download button's export
  payload. CSV checks cover ISO dates, unformatted numbers, missing revenue,
  empty exports, every metadata formula prefix (including leading whitespace),
  quoting/newlines, and source-data immutability. Edge cases live in
  `fixtures/search_campaigns.csv` and `fixtures/export_metadata.json`.
  Download-button calls are captured while running the real Streamlit widget;
  this checks its payload, not a browser's download transport.

- `test_csv_import.py`: original-header preview, automatic aliases, explicit
  mapping, ambiguous aliases, malformed/oversized CSVs, invalid dates/counts/
  amounts/metadata, and import confirmation preserving or replacing session data.
- `test_metrics.py`: frozen sample totals, weighted efficiency calculations,
  missing revenue per group, zero denominators and empty calculations.
- `test_dashboard.py`: all four views, individual and combined shared filters,
  inclusive date endpoints, partial/cleared date selection, empty results,
  the clear-filter callback, missing revenue, zero spend, and every weekly/
  monthly metric. Assertions inspect rendered cards, tables and Plotly traces,
  including the overview's intentional top-eight limit.
- `fixtures/sample_totals.json`: fixed migration baseline for the deterministic
  720-row illustrative dataset (not recomputed by the tests).
- `fixtures/aliased_campaigns.csv`: six hand-authored campaign-day records,
  unequal spend, zero denominators, blank revenue, and Sunday/Monday/month
  boundaries. Weekly/monthly expected buckets are explicit in the test.

Do not regenerate expected values from the implementation when a check fails.
First determine whether the product's metric rules intentionally changed.
ROI is `(sum(revenue) - sum(spend)) / sum(spend) * 100`, not mean row ROI.
Missing revenue makes that group's revenue and ROI unavailable. Zero spend
makes ROI unavailable; zero clicks/conversions make the corresponding rates
unavailable. Weekly periods start Monday; monthly periods start on the first.

AppTest does not provide a file-upload driver or an interactive Plotly element.
The import tests therefore exercise the real mapping form with CSV bytes;
dashboard tests seed imported rows in isolated session state and decode the
actual Plotly chart protobuf JSON (including typed base64 arrays). Native
upload transport and downloaded contents are covered by the separate browser
suite below, not by AppTest.

## Native browser uploads and downloads

Start the managed `artifacts/campaign-analyzer: web` workflow, then run from
the workspace root:

```sh
pnpm install --frozen-lockfile
uv sync --locked
pnpm --filter @workspace/campaign-analyzer run typecheck:browser
pnpm --filter @workspace/campaign-analyzer run test:browser
```

The default target is `http://localhost:80/`, through Replit's shared proxy.
The API server and mockup are not needed. A stopped web workflow causes the
tests to fail; the runner does not substitute a mock or seed session data.
To test a different running server, set `CAMPAIGN_BASE_URL` to its full URL,
including the trailing slash. Each test has a fresh browser context and
Streamlit session, so uploads and filters cannot leak between tests.

Replit's preinstalled `/repl/tools/bin/chromium` is detected automatically.
Elsewhere, install the matching browser once:

```sh
pnpm --filter @workspace/campaign-analyzer exec playwright install chromium
```

Alternatively, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chromium.
This suite requires a running Streamlit app and Chromium, unlike the Python
suite. It does not require credentials or a database.

`tests/browser/csv-transfers.spec.ts` covers:

- A real sample download: filename, CSV header, 720 rows, date endpoints,
  channels, and the frozen monetary/count totals.
- Native file input upload of `fixtures/aliased_campaigns.csv`, a successful
  Streamlit upload response, preview staging without replacing the active
  dataset, explicit import confirmation, and all six normalized exported rows.
- A second native upload with different headers: the prior filtered rows remain
  downloadable before confirmation; confirmation replaces them and resets
  visible date/channel/audience/goal controls. This intentionally does not test
  column-choice reuse.
- Each shared channel/audience/goal filter, an inclusive date range, their
  intersection, clear filters, and the actual downloaded rows after each.
  Blank revenue stays blank and X is normalized to Twitter. Sample download
  remains the full sample after importing another dataset.

Expectations are hand-authored or taken from the frozen totals fixture, never
calculated with the application functions. Numeric cells are compared by value
so `10` and `10.0` are equivalent; empty revenue is not converted to zero.
There are no fixed sleeps, mocked uploads, or automatic retries. Assertion
failures exit nonzero. Failure screenshots and Playwright traces are written to
`generated-artifacts/campaign-browser/` at the workspace root (ignored by Git
and deployment); successful temporary downloads are cleaned up with the
browser context. New date-format support and search/export security edge
cases are outside this suite's scope.
