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

The suite uses Python's standard `unittest` runner and Streamlit's `AppTest`.
No browser, API server, running Streamlit server, credentials, network access,
or database is needed. AppTest runs the real `app.py`, uses isolated session
state per test, and drives the actual date/multiselect/selectbox/button widgets.
Run all three `test_*.py` modules; an exception or mismatch exits nonzero.

## Coverage and fixtures

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
actual Plotly chart protobuf JSON (including typed base64 arrays). Browser-only
upload/download behavior is not claimed as tested.
