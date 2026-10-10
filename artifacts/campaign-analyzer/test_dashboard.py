"""Exercise the real app through widgets and inspect all four views."""

import base64
from datetime import date
import json
from pathlib import Path
import unittest

import numpy as np
import pandas as pd
from streamlit.testing.v1 import AppTest

from app import sample_data
from test_metrics import fixture_rows

APP = Path(__file__).with_name("app.py")
VIEWS = ["Overview", "Platform Comparison", "Campaign Details", "Time Series"]


def chart(tab):
    return json.loads(tab.get("plotly_chart")[0].proto.spec)


def values(encoded):
    """Plotly serializes numeric arrays as typed base64 buffers or plain lists."""
    if isinstance(encoded, dict):
        return np.frombuffer(base64.b64decode(encoded["bdata"]), dtype=encoded["dtype"])
    return np.asarray([float("nan") if value is None else value for value in encoded])


class DashboardTests(unittest.TestCase):
    def app(self, rows=None):
        app = AppTest.from_file(str(APP), default_timeout=20)
        if rows is not None:
            app.session_state.campaign_rows = rows.copy()
            app.session_state.dataset_source = "regression.csv"
            app.session_state.dataset_fingerprint = "regression"
        app.run()
        self.assertFalse(app.exception)
        self.assertEqual([tab.label for tab in app.tabs], VIEWS)
        return app

    def assert_views(self, app, expected, total):
        """Compare rendered values with raw sums, never app.summarize()."""
        self.assertFalse(app.exception)
        self.assertIn(f"{len(expected):,} of {total:,} campaign-day records",
                      [caption.value for caption in app.caption])
        spend = expected.spend.sum()
        clicks = expected.clicks.sum()
        conversions = expected.conversions.sum()
        roi = ((expected.revenue.sum() - spend) / spend * 100
               if spend and expected.revenue.notna().all() else None)
        cards = [f"${spend:,.2f}", f"{clicks:,}", f"{conversions:,}",
                 "N/A" if roi is None else f"{roi:,.1f}%"]
        for tab in app.tabs[:2]:
            self.assertEqual([metric.value for metric in tab.metric], cards)

        # Overview's snapshot is intentionally limited to the eight largest groups.
        for index, keys in ((0, ["channel", "campaign"]), (1, ["channel"]),
                            (2, ["channel", "campaign"])):
            actual = app.tabs[index].dataframe[0].value
            raw = expected.groupby(keys, sort=False).agg(
                spend=("spend", "sum"), clicks=("clicks", "sum"),
                conversions=("conversions", "sum"),
            ).reset_index().sort_values("spend", ascending=False)
            if index == 0:
                raw = raw.head(8)
            labels = {"channel": "Channel", "campaign": "Campaign",
                      "spend": "Spend · USD", "clicks": "Clicks · count",
                      "conversions": "Conversions · count"}
            wanted = raw.rename(columns=labels).reset_index(drop=True)
            pd.testing.assert_frame_equal(actual[wanted.columns].reset_index(drop=True),
                                          wanted, check_dtype=False)
            for _, row in actual.iterrows():
                group = expected
                for key in keys:
                    group = group[group[key] == row[labels[key]]]
                available = group.revenue.notna().all()
                self.assertEqual(pd.isna(row["Revenue · USD"]), not available)
                if available:
                    self.assertAlmostEqual(row["Revenue · USD"], group.revenue.sum())
                valid_roi = available and group.spend.sum() > 0
                self.assertEqual(pd.isna(row["ROI · %"]), not valid_roi)
                if valid_roi:
                    self.assertAlmostEqual(row["ROI · %"],
                                           (group.revenue.sum() / group.spend.sum() - 1) * 100)
        # Verify graphs too, so stale/unfiltered charts cannot pass table checks.
        daily = expected.groupby("date").agg(spend=("spend", "sum"),
                                             conversions=("conversions", "sum"))
        overview = chart(app.tabs[0])["data"]
        np.testing.assert_allclose(values(overview[0]["y"]), daily.spend)
        np.testing.assert_allclose(values(overview[1]["y"]), daily.conversions)
        comparison = chart(app.tabs[1])["data"]
        self.assertEqual(set(comparison[0]["x"]), set(expected.channel))
        by_channel = expected.groupby("channel")
        np.testing.assert_allclose(values(comparison[0]["y"]),
                                   [by_channel.spend.sum()[key] for key in comparison[0]["x"]])
        np.testing.assert_allclose(values(comparison[1]["y"]),
                                   [by_channel.conversions.sum()[key] for key in comparison[1]["x"]])
        series = chart(app.tabs[3])["data"][0]
        # Unlike the overview, the resampled series includes zero-valued gap days.
        dates = pd.date_range(expected.date.min(), expected.date.max(), freq="D")
        self.assertEqual(pd.to_datetime(series["x"]).tolist(), dates.tolist())
        np.testing.assert_allclose(values(series["y"]), daily.spend.reindex(dates, fill_value=0))

    def test_initial_sample_dashboard(self):
        self.assert_views(self.app(), sample_data(), 720)

    def test_each_shared_filter_and_combination_updates_all_views(self):
        rows = sample_data()
        cases = [
            ({"channel_filter": ["Facebook", "Instagram"]}, rows.channel.isin(["Facebook", "Instagram"])),
            ({"audience_filter": ["Adults 18–34"]}, rows.audience == "Adults 18–34"),
            ({"goal_filter": ["Sales"]}, rows.goal == "Sales"),
            ({"date_filter": (date(2026, 8, 10), date(2026, 8, 12))},
             rows.date.between("2026-08-10", "2026-08-12")),
            ({"channel_filter": ["Pinterest"], "audience_filter": ["Returning customers"],
              "goal_filter": ["Sales"], "date_filter": (date(2026, 9, 1), date(2026, 9, 3))},
             (rows.channel == "Pinterest") & (rows.audience == "Returning customers")
             & (rows.goal == "Sales") & rows.date.between("2026-09-01", "2026-09-03")),
        ]
        app = self.app()
        for selections, mask in cases:
            with self.subTest(filters=selections):
                app.button[0].click().run()
                for key, selection in selections.items():
                    if key == "date_filter":
                        app.date_input(key=key).set_value(selection)
                    else:
                        app.multiselect(key=key).set_value(selection)
                app.run()
                self.assert_views(app, rows[mask], 720)

    def test_empty_results_in_every_view_and_clear_callback(self):
        app = self.app()
        app.multiselect(key="channel_filter").set_value(["Twitter"])
        app.multiselect(key="audience_filter").set_value(["Adults 18–34"])
        app.multiselect(key="goal_filter").set_value(["Sales"])
        app.date_input(key="date_filter").set_value((date(2026, 8, 10), date(2026, 8, 12)))
        app.run()
        self.assertFalse(app.exception)
        self.assertIn("0 of 720 campaign-day records", [c.value for c in app.caption])
        for tab in app.tabs:
            self.assertEqual(len(tab.info), 1)
            self.assertIn("No campaigns match these filters", tab.info[0].value)
            self.assertFalse(tab.metric)
            self.assertFalse(tab.dataframe)
            self.assertFalse(tab.get("plotly_chart"))
        # Click the actual callback, not a direct session-state reset.
        app.button[0].click().run()
        self.assertEqual(app.date_input[0].value, (date(2026, 8, 1), date(2026, 9, 29)))
        for key in ("channel_filter", "audience_filter", "goal_filter"):
            self.assertEqual(app.multiselect(key=key).value, [])
        self.assert_views(app, sample_data(), 720)

    def test_partial_and_cleared_date_selection(self):
        app = self.app()
        app.date_input[0].set_value((date(2026, 8, 15),)).run()
        rows = sample_data()
        self.assert_views(app, rows[rows.date == "2026-08-15"], 720)
        app.date_input[0].set_value(()).run()
        self.assert_views(app, rows, 720)

    def test_missing_revenue_and_zero_denominators_render_safely(self):
        rows = fixture_rows()
        app = self.app(rows)
        self.assert_views(app, rows, 6)
        self.assertIn("missing revenue", app.warning[0].value)
        app.multiselect(key="channel_filter").set_value(["Pinterest"]).run()
        self.assert_views(app, rows[rows.channel == "Pinterest"], 6)
        self.assertFalse(app.warning)
        app = self.app(rows.assign(revenue=float("nan")))
        self.assert_views(app, rows.assign(revenue=float("nan")), 6)

    def test_weekly_monthly_metrics_and_missing_revenue_buckets(self):
        # Explicit golden buckets span Monday, Sunday and month boundaries.
        expected = {
            "Weekly": (
                ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"],
                [[120, 60, 12, 160, 100 / 3],
                 [0, 0, 0, 0, None], [0, 0, 0, 0, None], [0, 0, 0, 0, None],
                 [50, 25, 5, None, None], [100, 50, 10, 300, 200]],
            ),
            "Monthly": (
                ["2026-08-01", "2026-09-01", "2026-10-01"],
                [[10, 10, 1, 30, 200], [110, 50, 11, 130, 200 / 11],
                 [150, 75, 15, None, None]],
            ),
        }
        app = self.app(fixture_rows())
        for interval, (dates, buckets) in expected.items():
            for column, metric in enumerate(["Spend · USD", "Clicks · count", "Conversions · count",
                                             "Revenue · USD", "ROI · %"]):
                with self.subTest(interval=interval, metric=metric):
                    app.tabs[3].selectbox[0].select(interval)
                    app.tabs[3].selectbox[1].select(metric)
                    app.run()
                    self.assertFalse(app.exception)
                    spec = chart(app.tabs[3])
                    self.assertEqual(spec["layout"]["title"]["text"],
                                     f"{metric.split(' · ')[0]} by {interval.lower()} period")
                    trace = spec["data"][0]
                    self.assertEqual(pd.to_datetime(trace["x"]).strftime("%Y-%m-%d").tolist(), dates)
                    wanted = [float("nan") if bucket[column] is None else bucket[column]
                              for bucket in buckets]
                    np.testing.assert_allclose(values(trace["y"]), wanted, equal_nan=True)


if __name__ == "__main__":
    unittest.main()
