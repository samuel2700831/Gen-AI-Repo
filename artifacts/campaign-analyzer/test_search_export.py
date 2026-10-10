"""Focused search UI and spreadsheet export contracts, independent of ROI tests."""

import csv
from datetime import date
from io import StringIO
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import pandas as pd
import streamlit as st
from streamlit.testing.v1 import AppTest

from app import export_csv, parse_upload

APP = Path(__file__).with_name("app.py")
FIXTURES = APP.parent / "tests" / "fixtures"
METADATA = ("campaign", "channel", "audience", "goal")
HEADER = ["date", *METADATA, "spend", "clicks", "conversions", "revenue"]


def search_rows():
    return parse_upload((FIXTURES / "search_campaigns.csv").read_bytes())


def csv_rows(contents):
    return list(csv.DictReader(StringIO(contents, newline="")))


class ExportCsvTests(unittest.TestCase):
    def test_iso_dates_raw_numeric_values_and_missing_revenue(self):
        rows = search_rows()
        original = rows.copy(deep=True)
        text = export_csv(rows)
        self.assertEqual(next(csv.reader(StringIO(text))), HEADER)
        result = csv_rows(text)
        self.assertEqual([row["date"] for row in result],
                         [f"2026-09-{day:02d}" for day in range(1, 8)])
        expected_numbers = [
            ("10.25", "12345", "1", "20.5"), ("20.5", "40", "2", "41"),
            ("30.75", "60", "3", ""), ("0", "0", "0", "0"),
            ("40", "80", "4", "120"), ("50", "100", "5", "100"),
            ("60", "120", "6", "180"),
        ]
        for actual, expected in zip(result, expected_numbers, strict=True):
            for key, value in zip(HEADER[-4:], expected, strict=True):
                with self.subTest(date=actual["date"], column=key):
                    if value == "":
                        self.assertEqual(actual[key], "")
                    else:
                        self.assertEqual(float(actual[key]), float(value))
                        self.assertFalse(actual[key].startswith("'"))
                        self.assertNotIn("$", actual[key])
                        self.assertNotIn(",", actual[key])
        for column in METADATA:
            self.assertEqual([row[column] for row in result], rows[column].tolist())
        pd.testing.assert_frame_equal(rows, original)

    def test_all_metadata_formula_prefixes_whitespace_and_csv_quoting(self):
        cases = json.loads((FIXTURES / "export_metadata.json").read_text())
        frame = pd.DataFrame({
            column: [case["input"] for case in cases] for column in METADATA
        })
        frame.insert(0, "date", pd.date_range("2026-01-01", periods=len(cases)))
        # Negative numeric cells must remain numbers, not escaped metadata.
        frame["spend"] = -12.5
        frame["clicks"] = 1234567
        frame["conversions"] = 0
        frame["revenue"] = float("nan")
        original = frame.copy(deep=True)
        result = csv_rows(export_csv(frame))
        self.assertEqual(len(result), len(cases))
        for actual, case in zip(result, cases, strict=True):
            for column in METADATA:
                with self.subTest(column=column, value=case["input"]):
                    self.assertEqual(actual[column], case["expected"])
            self.assertEqual(actual["spend"], "-12.5")
            self.assertEqual(actual["clicks"], "1234567")
            self.assertEqual(actual["conversions"], "0")
            self.assertEqual(actual["revenue"], "")
        pd.testing.assert_frame_equal(frame, original)
        self.assertEqual(export_csv(frame), export_csv(frame))

    def test_empty_frame_has_header_only_and_optional_columns_work(self):
        frame = search_rows()
        reader = csv.reader(StringIO(export_csv(frame.iloc[:0])))
        self.assertEqual(list(reader), [HEADER])
        numeric_only = frame[["date", "spend", "clicks"]].iloc[:1]
        self.assertEqual(csv_rows(export_csv(numeric_only)), [
            {"date": "2026-09-01", "spend": "10.25", "clicks": "12345"}
        ])


class CampaignSearchTests(unittest.TestCase):
    def app(self, rows=None):
        app = AppTest.from_file(str(APP), default_timeout=20)
        app.session_state.campaign_rows = search_rows() if rows is None else rows.copy()
        app.session_state.dataset_source = "search_campaigns.csv"
        app.session_state.dataset_fingerprint = "search-regression"
        app.run()
        self.assertFalse(app.exception)
        return app

    def search(self, app, query):
        app.tabs[2].text_input[0].set_value(query).run()
        self.assertFalse(app.exception)

    def snapshot_other_views(self, app):
        return {
            "views": [
                {
                    "metrics": [(m.label, m.value) for m in tab.metric],
                    "tables": [table.value.copy(deep=True) for table in tab.dataframe],
                    "charts": [json.loads(chart.proto.spec) for chart in tab.get("plotly_chart")],
                    "info": [item.value for item in tab.info],
                }
                for tab in (app.tabs[0], app.tabs[1], app.tabs[3])
            ],
            "captions": [item.value for item in app.caption],
            "warnings": [item.value for item in app.warning],
            "dates": app.date_input[0].value,
            "filters": [widget.value[:] for widget in app.multiselect],
        }

    def assert_other_views_unchanged(self, app, before):
        after = self.snapshot_other_views(app)
        for old, new in zip(before.pop("views"), after.pop("views"), strict=True):
            for left, right in zip(old.pop("tables"), new.pop("tables"), strict=True):
                pd.testing.assert_frame_equal(left, right)
            self.assertEqual(old, new)
        self.assertEqual(before, after)

    def test_case_insensitive_literal_search_across_all_metadata(self):
        app = self.app()
        cases = [
            ("aLpHa", {"Alpha [VIP]"}, [30.75]),
            ("  fAcEbOoK  ", {"Alpha [VIP]", "Plain control"}, [50, 30.75]),
            ("sTuDeNtS", {"Alpha [VIP]", "Star*sale"}, [10.25, 0]),
            ("aWaReNeSs", {"Alpha [VIP]", "Straße launch"}, [60, 20.5]),
            ("[VIP]", {"Alpha [VIP]"}, [30.75]),
            (".", {"Dot.launch"}, [30.75]),
            ("*", {"Star*sale"}, [0]),
            ("A|B", {"A|B"}, [40]),
            ("(25+)", {"Dot.launch"}, [30.75]),
            ("^boost$", {"A|B"}, [40]),
            ("STRASSE", {"Straße launch"}, [60]),
        ]
        for query, campaigns, spend in cases:
            with self.subTest(query=query):
                before = self.snapshot_other_views(app)
                self.search(app, query)
                table = app.tabs[2].dataframe[0].value
                self.assertEqual(set(table["Campaign"]), campaigns)
                self.assertEqual(table["Spend · USD"].tolist(), spend)
                self.assertFalse(app.tabs[2].info)
                self.assert_other_views_unchanged(app, before)
        pd.testing.assert_frame_equal(app.session_state.campaign_rows, search_rows())

    def test_blank_and_whitespace_search_restore_every_detail_group(self):
        app = self.app()
        original = app.tabs[2].dataframe[0].value.copy(deep=True)
        for query in ("", "   ", "\t\n", " \r\n\t "):
            with self.subTest(query=repr(query)):
                self.search(app, "Alpha")
                before = self.snapshot_other_views(app)
                self.search(app, query)
                pd.testing.assert_frame_equal(app.tabs[2].dataframe[0].value, original)
                self.assertFalse(app.tabs[2].info)
                self.assert_other_views_unchanged(app, before)

    def test_no_match_and_numeric_date_only_queries_show_search_message(self):
        app = self.app()
        for query in ("not present", "12345", "2026-09-01", ".*", "\\", "[missing"):
            with self.subTest(query=query):
                before = self.snapshot_other_views(app)
                self.search(app, query)
                details = app.tabs[2]
                self.assertFalse(details.dataframe)
                self.assertEqual([item.value for item in details.info],
                                 ["No campaign matches your search. Try another search term."])
                self.assert_other_views_unchanged(app, before)
        self.search(app, "Alpha")
        self.assertEqual(len(app.tabs[2].dataframe[0].value), 1)
        self.assertFalse(app.tabs[2].info)

    def test_search_intersects_shared_filters_but_export_uses_all_filtered_rows(self):
        app = self.app()
        app.multiselect(key="channel_filter").set_value(["Facebook"])
        app.date_input[0].set_value((date(2026, 9, 2), date(2026, 9, 6))).run()
        before = self.snapshot_other_views(app)
        with patch.object(st, "download_button", wraps=st.download_button) as download:
            self.search(app, "alpha")
        self.assertEqual(app.tabs[2].dataframe[0].value["Spend · USD"].tolist(), [20.5])
        self.assert_other_views_unchanged(app, before)
        calls = [call for call in download.call_args_list
                 if call.args[0] == "Export filtered CSV"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].kwargs["file_name"], "adscope-filtered-campaigns.csv")
        self.assertEqual(calls[0].kwargs["mime"], "text/csv")
        exported = csv_rows(calls[0].kwargs["data"])
        self.assertEqual([row["campaign"] for row in exported], ["Alpha [VIP]", "Plain control"])
        self.assertEqual([row["date"] for row in exported], ["2026-09-02", "2026-09-06"])
        self.assertEqual([float(row["spend"]) for row in exported], [20.5, 50])
        matching_payload = calls[0].kwargs["data"]
        scope_caption = (
            "Export includes all campaign-day records matching the date, channel, "
            "audience, and goal filters. Campaign search only affects the table, not the CSV."
        )
        self.assertIn(scope_caption, [item.value for item in app.tabs[2].caption])
        # A search cannot bring back a campaign excluded by the shared filters.
        for query in ("Instagram", "not present"):
            with self.subTest(query=query):
                before = self.snapshot_other_views(app)
                with patch.object(st, "download_button", wraps=st.download_button) as download:
                    self.search(app, query)
                self.assertFalse(app.tabs[2].dataframe)
                self.assertIn("No campaign matches your search", app.tabs[2].info[0].value)
                calls = [call for call in download.call_args_list
                         if call.args[0] == "Export filtered CSV"]
                self.assertEqual(len(calls), 1)
                self.assertEqual(len(app.tabs[2].get("download_button")), 1)
                self.assertEqual(calls[0].kwargs["data"], matching_payload)
                self.assertEqual(calls[0].kwargs["file_name"], "adscope-filtered-campaigns.csv")
                self.assertEqual(calls[0].kwargs["mime"], "text/csv")
                self.assertIn(scope_caption, [item.value for item in app.tabs[2].caption])
                self.assert_other_views_unchanged(app, before)

    def test_empty_shared_filter_dataset_has_no_export(self):
        app = self.app()
        self.search(app, "alpha")
        app.multiselect(key="channel_filter").set_value(["Facebook"])
        with patch.object(st, "download_button", wraps=st.download_button) as download:
            app.date_input[0].set_value((date(2026, 9, 3), date(2026, 9, 3))).run()
        self.assertFalse(app.exception)
        self.assertIn("0 of 7 campaign-day records", [item.value for item in app.caption])
        self.assertFalse(app.tabs[2].dataframe)
        self.assertFalse(app.tabs[2].text_input)
        self.assertFalse(app.tabs[2].get("download_button"))
        self.assertFalse([call for call in download.call_args_list
                          if call.args[0] == "Export filtered CSV"])

    def test_download_button_receives_formula_safe_metadata_and_raw_numbers(self):
        rows = search_rows().iloc[:4].copy()
        for column in ("campaign", "audience", "goal"):
            rows[column] = ["  =SUM(1,2)", "\t+1+2", "\n-1+2", " @SUM(A1:A2)"]
        with patch.object(st, "download_button", wraps=st.download_button) as download:
            app = self.app(rows)
        self.assertFalse(app.exception)
        calls = [call for call in download.call_args_list
                 if call.args[0] == "Export filtered CSV"]
        self.assertEqual(len(calls), 1)
        result = csv_rows(calls[0].kwargs["data"])
        for column in ("campaign", "audience", "goal"):
            self.assertEqual([row[column] for row in result],
                             ["'  =SUM(1,2)", "'\t+1+2", "'\n-1+2", "' @SUM(A1:A2)"])
        self.assertEqual([row["channel"] for row in result], rows.channel.tolist())
        self.assertEqual([row["date"] for row in result],
                         ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"])
        self.assertEqual([float(row["spend"]) for row in result], [10.25, 20.5, 30.75, 0])
        self.assertEqual([int(row["clicks"]) for row in result], [12345, 40, 60, 0])
        self.assertEqual(result[2]["revenue"], "")
        pd.testing.assert_frame_equal(app.session_state.campaign_rows, rows)


if __name__ == "__main__":
    unittest.main()
