"""Run with: python -m unittest discover -s artifacts/campaign-analyzer."""

import csv
from io import StringIO
from pathlib import Path
import unittest

import pandas as pd
from streamlit.testing.v1 import AppTest

from app import ALIASES, REQUIRED, parse_upload, read_upload, suggest_mapping


def csv_bytes(headers, values):
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(headers)
    writer.writerow(values)
    return output.getvalue().encode("utf-8")


VALUES = ["2026-09-01", "Launch", "Facebook", "Adults", "Sales", "10", "20", "2"]
CUSTOM_HEADERS = ["When", "Name", "Network", "Segment", "Purpose", "Budget", "Visits", "Results"]
CUSTOM = csv_bytes(CUSTOM_HEADERS, VALUES)
MAPPING = dict(zip(REQUIRED, CUSTOM_HEADERS))


class CsvImportTests(unittest.TestCase):
    def test_original_headers_and_values_are_preserved_in_preview(self):
        frame = read_upload(CUSTOM)
        self.assertEqual(list(frame.columns), CUSTOM_HEADERS)
        self.assertEqual(frame.iloc[0].tolist(), VALUES)
        self.assertTrue(all(value is None for value in suggest_mapping(frame).values()))

    def test_custom_mapping_and_optional_revenue(self):
        result = parse_upload(CUSTOM, MAPPING)
        self.assertEqual(list(result.columns), [*REQUIRED, "revenue"])
        self.assertEqual(result.iloc[0]["campaign"], "Launch")
        self.assertEqual(result.iloc[0]["spend"], 10)
        self.assertTrue(result["revenue"].isna().all())
        data = csv_bytes([*CUSTOM_HEADERS, "Sales USD"], [*VALUES, "30"])
        self.assertEqual(parse_upload(data, {**MAPPING, "revenue": "Sales USD"}).iloc[0]["revenue"], 30)

    def test_aliases_remain_supported(self):
        data = csv_bytes(
            ["Day", "Campaign Name", "Platform", "Target Audience", "Objective",
             "Amount-Spent", "Total Clicks", "Total Conversions", "Conversion Value"],
            [*VALUES, "30"],
        )
        self.assertEqual(parse_upload(data).iloc[0]["revenue"], 30)

    def test_ambiguous_alias_requires_choice(self):
        data = csv_bytes([*REQUIRED, "cost"], [*VALUES, "99"])
        self.assertIsNone(suggest_mapping(read_upload(data))["spend"])
        with self.assertRaisesRegex(ValueError, "Missing required"):
            parse_upload(data)
        result = parse_upload(data, {key: key for key in REQUIRED})
        self.assertEqual(result.iloc[0]["spend"], 10)

    def test_invalid_mapping_is_rejected(self):
        for mapping, message in [
            ({**MAPPING, "goal": None}, "Missing required"),
            ({**MAPPING, "spend": "Visits"}, "only one field"),
            ({**MAPPING, "revenue": "Budget"}, "only one field"),
            ({**MAPPING, "spend": "Not present"}, "must exist"),
            ({**MAPPING, "provider": "Budget"}, "Unknown mapping"),
        ]:
            with self.subTest(mapping=mapping), self.assertRaisesRegex(ValueError, message):
                parse_upload(CUSTOM, mapping)

    def test_value_validation_is_unchanged_for_mapped_columns(self):
        cases = [
            (0, "09/01/2026", "YYYY-MM-DD"),
            (0, "2026-02-30", "YYYY-MM-DD"),
            (1, "", "cannot be blank"),
            (2, "Unknown", "Channel must"),
            (3, "", "cannot be blank"),
            (4, "", "cannot be blank"),
            (5, "-1", "non-negative"),
            (5, "inf", "non-negative"),
            (5, "9007199254740992", "non-negative"),
            (6, "1.5", "whole-number"),
            (7, "", "non-negative"),
        ]
        for position, value, message in cases:
            values = VALUES.copy()
            values[position] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, message):
                parse_upload(csv_bytes(CUSTOM_HEADERS, values), MAPPING)
        with self.assertRaisesRegex(ValueError, "revenue must"):
            parse_upload(csv_bytes([*CUSTOM_HEADERS, "Money"], [*VALUES, "invalid"]),
                         {**MAPPING, "revenue": "Money"})

    def test_structural_limits(self):
        for data, message in [
            (b"x" * (5 * 1024 * 1024 + 1), "5 MB"),
            (b"\xff", "UTF-8"),
            (b"a,b\n1\n", "same number"),
            (b"Date,date\n1,2\n", "duplicate"),
            (b"a, \n1,2\n", "cannot be blank"),
            (b"a,b\n", "at least one"),
            (b'a,b\n"unterminated,2\n', "Could not read"),
            (b"a\n" + b"1\n" * 50_001, "50,000"),
        ]:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                read_upload(data)


class MappingUiTests(unittest.TestCase):
    def app(self, contents=CUSTOM):
        path = str(Path(__file__).parent.resolve())
        return AppTest.from_string(f"""
import sys
sys.path.insert(0, {path!r})
import streamlit as st
from app import render_csv_import, sample_data
if "campaign_rows" not in st.session_state:
    st.session_state.campaign_rows = sample_data()
    st.session_state.dataset_source = "sample"
    st.session_state.dataset_fingerprint = "sample"
    for key in ("date_filter", "channel_filter", "audience_filter", "goal_filter"):
        st.session_state[key] = ["original"]
render_csv_import({contents!r}, "custom.csv", "custom")
""").run()

    def test_preview_failure_retry_and_success(self):
        app = self.app()
        original = app.session_state.campaign_rows.copy()
        self.assertFalse(app.exception)
        self.assertEqual(len(app.selectbox), len(ALIASES))
        self.assertEqual(app.dataframe[0].value.columns.tolist(), CUSTOM_HEADERS)
        app.button[0].click().run()
        self.assertIn("Missing required", app.error[0].value)
        pd.testing.assert_frame_equal(app.session_state.campaign_rows, original)
        self.assertEqual(app.session_state.goal_filter, ["original"])
        for selectbox, header in zip(app.selectbox, CUSTOM_HEADERS):
            selectbox.select(header)
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertFalse(app.error)
        self.assertEqual(app.session_state.dataset_source, "custom.csv")
        self.assertEqual(app.session_state.dataset_fingerprint, "custom")
        self.assertEqual(len(app.session_state.campaign_rows), 1)
        self.assertTrue(app.session_state.campaign_rows["revenue"].isna().all())
        for key in ("date_filter", "channel_filter", "audience_filter", "goal_filter"):
            self.assertNotIn(key, app.session_state)

    def test_bad_values_keep_current_data_and_choices(self):
        values = VALUES.copy()
        values[5] = "-10"
        app = self.app(csv_bytes(CUSTOM_HEADERS, values))
        for selectbox, header in zip(app.selectbox, CUSTOM_HEADERS):
            selectbox.select(header)
        app.button[0].click().run()
        self.assertIn("spend must", app.error[0].value)
        self.assertEqual(app.session_state.dataset_source, "sample")
        self.assertEqual(len(app.session_state.campaign_rows), 720)
        self.assertEqual(app.session_state.channel_filter, ["original"])
        self.assertEqual(app.selectbox[0].value, "When")

    def test_new_file_resets_mapping_choices(self):
        app = self.app()
        app.selectbox[0].select("When").run()
        app.session_state.mapping_fingerprint = "old-file"
        app.run()
        self.assertIsNone(app.selectbox[0].value)
        self.assertEqual(app.session_state.dataset_source, "sample")


if __name__ == "__main__":
    unittest.main()
