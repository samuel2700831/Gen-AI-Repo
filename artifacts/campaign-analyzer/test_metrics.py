"""Calculation regressions; expected values are independent of app helpers."""

import json
from pathlib import Path
import unittest

import pandas as pd

from app import grouped_metrics, metric_label, parse_upload, roi, sample_data, summarize

FIXTURES = Path(__file__).parent / "tests" / "fixtures"


def fixture_rows():
    return parse_upload((FIXTURES / "aliased_campaigns.csv").read_bytes())


class MetricTests(unittest.TestCase):
    def test_sample_golden_totals_and_shape(self):
        expected = json.loads((FIXTURES / "sample_totals.json").read_text())
        rows = sample_data()
        self.assertEqual(len(rows), expected["rows"])
        self.assertEqual(str(rows.date.min().date()), expected["start"])
        self.assertEqual(str(rows.date.max().date()), expected["end"])
        self.assertEqual(rows.groupby("channel").size().tolist(), [180] * 4)
        self.assertEqual(rows.groupby("campaign").size().tolist(), [240] * 3)
        pd.testing.assert_frame_equal(rows, sample_data())
        for key, actual in summarize(rows).items():
            with self.subTest(metric=key):
                self.assertAlmostEqual(actual, expected[key], places=8)

    def test_aliased_fixture_normalizes_channels_and_blank_revenue(self):
        rows = fixture_rows()
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows.channel.tolist(),
                         ["Facebook", "Facebook", "Instagram", "Pinterest", "Twitter", "Facebook"])
        self.assertEqual(rows.spend.tolist(), [10, 90, 20, 0, 50, 100])
        self.assertTrue(pd.isna(rows.iloc[4].revenue))
        self.assertEqual(rows.date.iloc[0], pd.Timestamp("2026-08-31"))

    def test_weighted_metrics_not_average_row_rates(self):
        # Row ROIs are 200% and 0%; averaging would give 100%, not 20%.
        stats = summarize(fixture_rows().iloc[:2])
        expected = dict(spend=100, clicks=40, conversions=10, revenue=120,
                        roi=20, cpc=2.5, cpa=10, conversion_rate=25)
        for key, value in expected.items():
            with self.subTest(metric=key):
                self.assertAlmostEqual(stats[key], value)

    def test_missing_revenue_invalidates_only_affected_groups(self):
        rows = fixture_rows()
        for frame in (rows, rows.assign(revenue=float("nan"))):
            stats = summarize(frame)
            self.assertIsNone(stats["revenue"])
            self.assertIsNone(stats["roi"])
            self.assertEqual(stats["spend"], 270)
            self.assertEqual(stats["conversions"], 27)
        for by in ("channel", ["channel", "campaign"]):
            groups = grouped_metrics(rows, by)
            facebook = groups.loc[groups.channel == "Facebook"].iloc[0]
            twitter = groups.loc[groups.channel == "Twitter"].iloc[0]
            self.assertEqual(facebook.revenue, 420)
            self.assertAlmostEqual(facebook.roi, 110)
            self.assertTrue(pd.isna(twitter.revenue))
            self.assertTrue(pd.isna(twitter.roi))

    def test_zero_denominators_and_zero_revenue(self):
        stats = summarize(fixture_rows().iloc[[3]])
        for key in ("roi", "cpc", "cpa", "conversion_rate"):
            self.assertIsNone(stats[key])
            self.assertEqual(metric_label(stats[key], key), "N/A")
        self.assertEqual(stats["revenue"], 0)
        self.assertEqual(roi(0, 10), -100)
        for revenue, spend in ((None, 10), (float("nan"), 10), (100, 0), (0, 0)):
            with self.subTest(revenue=revenue, spend=spend):
                self.assertIsNone(roi(revenue, spend))
        stats = summarize(fixture_rows().iloc[:1].assign(clicks=0, conversions=0))
        self.assertIsNone(stats["cpc"])
        self.assertIsNone(stats["cpa"])
        self.assertIsNone(stats["conversion_rate"])

    def test_empty_calculations(self):
        empty = fixture_rows().iloc[:0]
        self.assertEqual(summarize(empty),
                         dict(spend=0, clicks=0, conversions=0, revenue=None,
                              roi=None, cpc=None, cpa=None, conversion_rate=None))
        for by in ("channel", ["channel", "campaign"]):
            self.assertTrue(grouped_metrics(empty, by).empty)


if __name__ == "__main__":
    unittest.main()
