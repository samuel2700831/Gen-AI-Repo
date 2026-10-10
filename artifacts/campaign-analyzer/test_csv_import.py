"""Run with: python -m unittest discover -s artifacts/campaign-analyzer."""

import csv
from io import StringIO
from pathlib import Path
import unittest

import pandas as pd
from streamlit.testing.v1 import AppTest

from app import (
    ALIASES, DATE_FORMATS, REQUIRED, export_csv, interpreted_date_preview,
    parse_upload, read_upload, suggest_mapping,
)


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
    def test_interpreted_preview_preserves_values_and_limits_rows(self):
        values = pd.Series([" 03/04/2026 ", "02/30/2026", "", "3/04/2026"] + ["05/06/2026"] * 8)
        original = values.copy()
        preview = interpreted_date_preview(values, "MM/DD/YYYY")
        self.assertEqual(len(preview), 10)
        self.assertEqual(preview["CSV row"].tolist(), list(range(2, 12)))
        self.assertEqual(preview["Original date"].tolist(), values.head(10).tolist())
        self.assertEqual(preview["Interpreted date (YYYY-MM-DD)"].tolist()[:4],
                         ["2026-03-04", "Invalid date", "Invalid date", "Invalid date"])
        pd.testing.assert_series_equal(values, original)

    def test_interpreted_preview_pages_preserve_positions_and_boundaries(self):
        values = pd.Series(["03/04/2026"] * 20 + [" 05/06/2026 ", "02/30/2026", "3/04/2026"])
        original = values.copy()
        for page, rows in [(1, range(2, 12)), (2, range(12, 22)), (3, range(22, 25))]:
            preview = interpreted_date_preview(values, "MM/DD/YYYY", page)
            self.assertEqual(preview["CSV row"].tolist(), list(rows))
            self.assertLessEqual(len(preview), 10)
            self.assertEqual(preview["Original date"].tolist(),
                             values.iloc[(page - 1) * 10:page * 10].tolist())
        self.assertEqual(preview.iloc[:, 2].tolist(),
                         ["2026-05-06", "Invalid date", "Invalid date"])
        for page in (0, 4):
            with self.assertRaisesRegex(ValueError, "Preview page"):
                interpreted_date_preview(values, "MM/DD/YYYY", page)
        pd.testing.assert_series_equal(values, original)

    def dated_csv(self, *dates):
        output = StringIO()
        writer = csv.writer(output)
        writer.writerow(CUSTOM_HEADERS)
        for value in dates:
            writer.writerow([value, *VALUES[1:]])
        return output.getvalue().encode("utf-8")

    def test_selected_formats_normalize_to_shared_datetime_and_iso_export(self):
        for date_format, dates in [
            ("YYYY-MM-DD", ("2024-02-29", "2026-09-13")),
            ("MM/DD/YYYY", ("02/29/2024", "09/13/2026")),
            ("DD/MM/YYYY", ("29/02/2024", "13/09/2026")),
            ("YYYY/MM/DD", ("2024/02/29", "2026/09/13")),
            ("MM-DD-YYYY", ("02-29-2024", "09-13-2026")),
            ("DD-MM-YYYY", ("29-02-2024", "13-09-2026")),
        ]:
            with self.subTest(date_format=date_format):
                data = self.dated_csv(*dates)
                preview = read_upload(data)
                result = parse_upload(data, MAPPING, date_format)
                self.assertEqual(preview["When"].tolist(), list(dates))
                self.assertTrue(pd.api.types.is_datetime64_any_dtype(result["date"]))
                self.assertEqual(result["date"].tolist(),
                                 [pd.Timestamp("2024-02-29"), pd.Timestamp("2026-09-13")])
                filtered = result[result["date"].dt.date >= pd.Timestamp("2026-09-01").date()]
                self.assertEqual(len(filtered), 1)
                self.assertIn("2026-09-13", export_csv(filtered))
                self.assertEqual(filtered.iloc[0]["spend"], 10)
                self.assertEqual(filtered.iloc[0]["audience"], "Adults")
                self.assertTrue(filtered["revenue"].isna().all())

    def test_ambiguous_order_requires_explicit_choice(self):
        data = self.dated_csv("03/04/2026")
        with self.assertRaisesRegex(ValueError, "Row 2:.*YYYY-MM-DD"):
            parse_upload(data, MAPPING)
        self.assertEqual(parse_upload(data, MAPPING, "MM/DD/YYYY").iloc[0]["date"],
                         pd.Timestamp("2026-03-04"))
        self.assertEqual(parse_upload(data, MAPPING, "DD/MM/YYYY").iloc[0]["date"],
                         pd.Timestamp("2026-04-03"))
        # A clearly day-first date must not trigger fallback in month-first mode.
        with self.assertRaisesRegex(ValueError, "MM/DD/YYYY"):
            parse_upload(self.dated_csv("13/09/2026"), MAPPING, "MM/DD/YYYY")

    def test_new_formats_require_selection_and_never_guess_dash_order(self):
        for date_format, value in [
            ("YYYY/MM/DD", "2026/03/04"),
            ("MM-DD-YYYY", "03-04-2026"),
            ("DD-MM-YYYY", "03-04-2026"),
        ]:
            with self.subTest(date_format=date_format):
                with self.assertRaisesRegex(ValueError, "Row 2:.*YYYY-MM-DD"):
                    parse_upload(self.dated_csv(value), MAPPING)
        data = self.dated_csv("03-04-2026")
        self.assertEqual(parse_upload(data, MAPPING, "MM-DD-YYYY").iloc[0]["date"],
                         pd.Timestamp("2026-03-04"))
        self.assertEqual(parse_upload(data, MAPPING, "DD-MM-YYYY").iloc[0]["date"],
                         pd.Timestamp("2026-04-03"))
        for date_format, value in [
            ("MM-DD-YYYY", "13-09-2026"),
            ("DD-MM-YYYY", "09-13-2026"),
        ]:
            with self.subTest(date_format=date_format):
                with self.assertRaisesRegex(ValueError, f"Row 2:.*{date_format}"):
                    parse_upload(self.dated_csv(value), MAPPING, date_format)

    def test_selected_date_formats_reject_impossible_and_malformed_dates(self):
        for date_format, dates in [
            ("YYYY-MM-DD", ("2026-02-29", "2026-13-01", "2026-9-01", "2026-09-01T00:00:00")),
            ("MM/DD/YYYY", ("02/29/2026", "04/31/2026", "00/01/2026", "09/00/2026",
                            "9/01/2026", "09/1/2026", "09/01/26", "09-01-2026")),
            ("DD/MM/YYYY", ("29/02/2026", "31/04/2026", "01/00/2026", "00/09/2026",
                            "1/09/2026", "01/9/2026", "01/09/26", "01-09-2026")),
            ("YYYY/MM/DD", ("2026/02/29", "2026/04/31", "2026/00/01", "2026/09/00",
                            "2026/9/01", "2026/09/1", "26/09/01", "2026-09-01",
                            "2026/09-01", "2026/09/01T00:00:00")),
            ("MM-DD-YYYY", ("02-29-2026", "04-31-2026", "00-01-2026", "09-00-2026",
                            "9-01-2026", "09-1-2026", "09-01-26", "09/01/2026",
                            "09-01/2026", "09-01-2026T00:00:00")),
            ("DD-MM-YYYY", ("29-02-2026", "31-04-2026", "01-00-2026", "00-09-2026",
                            "1-09-2026", "01-9-2026", "01-09-26", "01/09/2026",
                            "01-09/2026", "01-09-2026T00:00:00")),
        ]:
            for value in dates:
                with self.subTest(date_format=date_format, value=value):
                    with self.assertRaisesRegex(ValueError, f"Row 2:.*{date_format}"):
                        parse_upload(self.dated_csv(value), MAPPING, date_format)
        for date_format in DATE_FORMATS:
            with self.subTest(date_format=date_format), self.assertRaisesRegex(ValueError, "date cannot be blank"):
                parse_upload(self.dated_csv(""), MAPPING, date_format)

    def test_mixed_formats_report_first_bad_row_without_fallback(self):
        for date_format, dates in [
            ("YYYY-MM-DD", ("2026-09-01", "09/02/2026")),
            ("MM/DD/YYYY", ("09/01/2026", "2026-09-02")),
            ("DD/MM/YYYY", ("01/09/2026", "2026-09-02")),
            ("MM/DD/YYYY", ("09/13/2026", "14/09/2026")),
            ("DD/MM/YYYY", ("13/09/2026", "09/14/2026")),
            ("YYYY/MM/DD", ("2026/09/01", "2026-09-02")),
            ("MM-DD-YYYY", ("09-01-2026", "09/02/2026")),
            ("DD-MM-YYYY", ("01-09-2026", "02/09/2026")),
            ("MM-DD-YYYY", ("09-13-2026", "14-09-2026")),
            ("DD-MM-YYYY", ("13-09-2026", "09-14-2026")),
        ]:
            with self.subTest(date_format=date_format), self.assertRaisesRegex(ValueError, "Row 3:"):
                parse_upload(self.dated_csv(*dates), MAPPING, date_format)
        with self.assertRaisesRegex(ValueError, "Unsupported date format"):
            parse_upload(CUSTOM, MAPPING, "auto")

    def test_selected_date_format_with_suggested_mapping(self):
        data = csv_bytes(REQUIRED, ["13/09/2026", *VALUES[1:]])
        self.assertEqual(parse_upload(data, date_format="DD/MM/YYYY").iloc[0]["date"],
                         pd.Timestamp("2026-09-13"))

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
    def test_date_preview_navigation_and_edits_never_commit(self):
        output = StringIO()
        writer = csv.writer(output)
        writer.writerow([*CUSTOM_HEADERS, "Other date"])
        for value in ["03/04/2026"] * 20 + [" 05/06/2026 ", "07/08/2026", "09/10/2026"]:
            writer.writerow([value, *VALUES[1:], "11/12/2026"])
        data = output.getvalue().encode("utf-8")
        app = self.app(data)
        original = app.session_state.campaign_rows.copy()
        for field, header in MAPPING.items():
            app.selectbox(key=f"csv_mapping_{field}").select(header)
        app.selectbox(key="csv_date_format").select("MM/DD/YYYY").run()
        self.assertEqual(app.number_input(key="csv_date_preview_page").value, 1)
        for page, rows in [(2, range(12, 22)), (3, range(22, 25)), (1, range(2, 12)), (3, range(22, 25))]:
            app.number_input(key="csv_date_preview_page").set_value(page).run()
            self.assertFalse(app.exception)
            self.assertEqual(app.dataframe[1].value["CSV row"].tolist(), list(rows))
            self.assert_active_unchanged(app, original)
        self.assertEqual(app.dataframe[1].value.iloc[0, 1], " 05/06/2026 ")
        self.assertEqual(app.dataframe[1].value.iloc[0, 2], "2026-05-06")
        self.assertTrue(any("Page 3 of 3 · CSV rows 22–24" in c.value for c in app.caption))
        app.selectbox(key="csv_date_format").select("DD/MM/YYYY").run()
        self.assertEqual(app.number_input(key="csv_date_preview_page").value, 3)
        self.assertEqual(app.dataframe[1].value.iloc[0, 2], "2026-06-05")
        self.assert_active_unchanged(app, original)
        app.selectbox(key="csv_mapping_date").select("Other date").run()
        self.assertEqual(app.dataframe[1].value.iloc[:, 2].tolist(), ["2026-12-11"] * 3)
        self.assert_active_unchanged(app, original)
        app.selectbox(key="csv_mapping_date").select("When").run()
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertFalse(app.error)
        self.assertEqual(len(app.session_state.campaign_rows), 23)
        self.assertEqual(app.session_state.campaign_rows.iloc[20]["date"], pd.Timestamp("2026-06-05"))

    def test_date_preview_page_resets_for_new_upload_and_session(self):
        output = StringIO()
        writer = csv.writer(output)
        writer.writerow(CUSTOM_HEADERS)
        for _ in range(21):
            writer.writerow(VALUES)
        data = output.getvalue().encode("utf-8")
        app = self.changing_app(data)
        app.selectbox(key="csv_mapping_date").select("When").run()
        app.number_input(key="csv_date_preview_page").set_value(3).run()
        original = app.session_state.campaign_rows.copy()
        self.change_upload(app, CUSTOM, "short.csv")
        app.selectbox(key="csv_mapping_date").select("When").run()
        self.assertFalse(app.exception)
        self.assertEqual(app.number_input(key="csv_date_preview_page").value, 1)
        self.assertTrue(app.number_input(key="csv_date_preview_page").disabled)
        self.assertEqual(app.dataframe[1].value["CSV row"].tolist(), [2])
        pd.testing.assert_frame_equal(app.session_state.campaign_rows, original)
        self.change_upload(app, data, "long.csv")
        app.selectbox(key="csv_mapping_date").select("When").run()
        self.assertEqual(app.number_input(key="csv_date_preview_page").value, 1)
        fresh = self.app(data)
        fresh.selectbox(key="csv_mapping_date").select("When").run()
        self.assertEqual(fresh.number_input(key="csv_date_preview_page").value, 1)

    def test_new_formats_preview_confirm_and_reset_for_new_upload(self):
        for date_format, value, expected in [
            ("YYYY/MM/DD", "2026/03/04", "2026-03-04"),
            ("MM-DD-YYYY", "03-04-2026", "2026-03-04"),
            ("DD-MM-YYYY", "03-04-2026", "2026-04-03"),
        ]:
            with self.subTest(date_format=date_format):
                data = csv_bytes(CUSTOM_HEADERS, [value, *VALUES[1:]])
                app = self.app(data)
                original = app.session_state.campaign_rows.copy()
                self.assertEqual(app.selectbox(key="csv_date_format").value, "YYYY-MM-DD")
                self.assertIn(date_format, app.selectbox(key="csv_date_format").options)
                for field, header in MAPPING.items():
                    app.selectbox(key=f"csv_mapping_{field}").select(header)
                app.selectbox(key="csv_date_format").select(date_format).run()
                self.assertFalse(app.exception)
                self.assertEqual(app.dataframe[1].value["Original date"].tolist(), [value])
                self.assertEqual(app.dataframe[1].value.iloc[0, 2], expected)
                self.assert_active_unchanged(app, original)
                app.button[0].click().run()
                self.assertFalse(app.exception)
                self.assertFalse(app.error)
                self.assertEqual(app.session_state.campaign_rows.iloc[0]["date"],
                                 pd.Timestamp(expected))
                self.assertEqual(app.session_state.dataset_source, "custom.csv")
                self.assertEqual(app.session_state.date_filter,
                                 (pd.Timestamp(expected).date(),) * 2)
                for key in ("channel_filter", "audience_filter", "goal_filter"):
                    self.assertEqual(app.session_state[key], [])
                app.session_state.mapping_fingerprint = "previous-file"
                app.run()
                self.assertEqual(app.selectbox(key="csv_date_format").value, "YYYY-MM-DD")
                fresh = self.app(data)
                self.assertEqual(fresh.selectbox(key="csv_date_format").value, "YYYY-MM-DD")
                self.assertNotIn("last_successful_csv_mapping", fresh.session_state)

    def assert_active_unchanged(self, app, original):
        pd.testing.assert_frame_equal(app.session_state.campaign_rows, original)
        self.assertEqual(app.session_state.dataset_source, "sample")
        self.assertEqual(app.session_state.dataset_fingerprint, "sample")
        for key in ("date_filter", "channel_filter", "audience_filter", "goal_filter"):
            self.assertEqual(app.session_state[key], ["original"])
        self.assertNotIn("last_successful_csv_mapping", app.session_state)

    def test_live_date_preview_edits_then_confirms_latest_interpretation(self):
        headers = [*CUSTOM_HEADERS, "Other date"]
        data = csv_bytes(headers, ["03/04/2026", *VALUES[1:], "05/06/2026"])
        app = self.app(data)
        original = app.session_state.campaign_rows.copy()
        self.assertEqual(len(app.dataframe), 1)
        for field, header in MAPPING.items():
            app.selectbox(key=f"csv_mapping_{field}").select(header)
        app.selectbox(key="csv_date_format").select("MM/DD/YYYY").run()
        self.assertFalse(app.exception)
        self.assertEqual(app.dataframe[1].value["Original date"].tolist(), ["03/04/2026"])
        self.assertEqual(app.dataframe[1].value["Interpreted date (YYYY-MM-DD)"].tolist(),
                         ["2026-03-04"])
        self.assert_active_unchanged(app, original)
        app.selectbox(key="csv_date_format").select("DD/MM/YYYY").run()
        self.assertEqual(app.dataframe[1].value.iloc[0, 2], "2026-04-03")
        self.assert_active_unchanged(app, original)
        app.selectbox(key="csv_mapping_date").select("Other date").run()
        self.assertEqual(app.dataframe[1].value.iloc[0, 1], "05/06/2026")
        self.assertEqual(app.dataframe[1].value.iloc[0, 2], "2026-06-05")
        self.assert_active_unchanged(app, original)
        app.selectbox(key="csv_mapping_date").select_index(0).run()
        self.assertEqual(len(app.dataframe), 1)
        self.assert_active_unchanged(app, original)
        app.selectbox(key="csv_mapping_date").select("When").run()
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertFalse(app.error)
        self.assertEqual(app.session_state.campaign_rows.iloc[0]["date"],
                         pd.Timestamp("2026-04-03"))
        self.assertEqual(app.session_state.dataset_source, "custom.csv")
        self.assertEqual(app.session_state.dataset_fingerprint, "custom")
        self.assertEqual(app.session_state.date_filter,
                         (pd.Timestamp("2026-04-03").date(),) * 2)
        for key in ("channel_filter", "audience_filter", "goal_filter"):
            self.assertEqual(app.session_state[key], [])

    def test_date_preview_does_not_skip_invalid_rows_beyond_sample(self):
        output = StringIO()
        writer = csv.writer(output)
        writer.writerow(CUSTOM_HEADERS)
        for value in ["03/04/2026"] * 10 + ["02/30/2026"]:
            writer.writerow([value, *VALUES[1:]])
        app = self.app(output.getvalue().encode("utf-8"))
        original = app.session_state.campaign_rows.copy()
        for field, header in MAPPING.items():
            app.selectbox(key=f"csv_mapping_{field}").select(header)
        app.selectbox(key="csv_date_format").select("MM/DD/YYYY").run()
        self.assertEqual(len(app.dataframe[1].value), 10)
        self.assertNotIn("Invalid date", app.dataframe[1].value.iloc[:, 2].tolist())
        self.assert_active_unchanged(app, original)
        app.number_input(key="csv_date_preview_page").set_value(2).run()
        self.assertEqual(app.dataframe[1].value["CSV row"].tolist(), [12])
        self.assertEqual(app.dataframe[1].value.iloc[0, 2], "Invalid date")
        self.assert_active_unchanged(app, original)
        app.number_input(key="csv_date_preview_page").set_value(1).run()
        app.button[0].click().run()
        self.assertIn("Row 12:", app.error[0].value)
        self.assert_active_unchanged(app, original)

    def test_date_format_failure_retry_and_confirmation(self):
        data = csv_bytes(CUSTOM_HEADERS, ["03/04/2026", *VALUES[1:]])
        app = self.app(data)
        original = app.session_state.campaign_rows.copy()
        self.assertEqual(app.selectbox(key="csv_date_format").value, "YYYY-MM-DD")
        for field, header in MAPPING.items():
            app.selectbox(key=f"csv_mapping_{field}").select(header)
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertIn("YYYY-MM-DD", app.error[0].value)
        self.assertNotIn("last_successful_csv_mapping", app.session_state)
        self.assertEqual(app.session_state.date_filter, ["original"])
        pd.testing.assert_frame_equal(app.session_state.campaign_rows, original)
        self.assertEqual(app.dataframe[1].value.iloc[0, 2], "Invalid date")
        app.selectbox(key="csv_date_format").select("DD/MM/YYYY").run()
        self.assertEqual(app.dataframe[1].value.iloc[0, 2], "2026-04-03")
        # Live preview edits still leave the active dataset untouched.
        pd.testing.assert_frame_equal(app.session_state.campaign_rows, original)
        self.assertEqual(app.session_state.dataset_source, "sample")
        self.assertEqual(app.session_state.date_filter, ["original"])
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertFalse(app.error)
        self.assertEqual(app.session_state.campaign_rows.iloc[0]["date"],
                         pd.Timestamp("2026-04-03"))
        self.assertEqual(app.session_state.dataset_source, "custom.csv")
        self.assertEqual(app.session_state.dataset_fingerprint, "custom")
        self.assertEqual(app.session_state.date_filter,
                         (pd.Timestamp("2026-04-03").date(),) * 2)
        for key in ("channel_filter", "audience_filter", "goal_filter"):
            self.assertEqual(app.session_state[key], [])

    def test_date_format_not_carried_to_another_file_or_session(self):
        data = csv_bytes(CUSTOM_HEADERS, ["09/13/2026", *VALUES[1:]])
        app = self.changing_app(data)
        for field, header in MAPPING.items():
            app.selectbox(key=f"csv_mapping_{field}").select(header)
        app.selectbox(key="csv_date_format").select("MM/DD/YYYY")
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertFalse(app.error)
        saved = app.session_state.last_successful_csv_mapping
        original = app.session_state.campaign_rows.copy()
        app.session_state.channel_filter = ["Facebook"]
        bad_data = csv_bytes(CUSTOM_HEADERS, ["02/30/2026", *VALUES[1:]])
        self.change_upload(app, bad_data, "bad.csv")
        self.assert_choices(app, MAPPING)
        self.assertEqual(app.selectbox(key="csv_date_format").value, "YYYY-MM-DD")
        app.selectbox(key="csv_date_format").select("MM/DD/YYYY")
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertIn("Row 2:", app.error[0].value)
        self.assertIn("MM/DD/YYYY", app.error[0].value)
        self.assertEqual(app.selectbox(key="csv_date_format").value, "MM/DD/YYYY")
        self.assertEqual(app.session_state.last_successful_csv_mapping, saved)
        self.assertEqual(app.session_state.channel_filter, ["Facebook"])
        self.assertEqual(app.session_state.dataset_source, "first.csv")
        self.assertEqual(app.session_state.dataset_fingerprint, "first.csv")
        pd.testing.assert_frame_equal(app.session_state.campaign_rows, original)
        self.change_upload(app, CUSTOM, "iso.csv")
        self.assertEqual(app.selectbox(key="csv_date_format").value, "YYYY-MM-DD")
        app.button[0].click().run()
        self.assertFalse(app.error)
        self.assertEqual(app.session_state.campaign_rows.iloc[0]["date"],
                         pd.Timestamp("2026-09-01"))
        fresh = self.changing_app(data)
        self.assertEqual(fresh.selectbox(key="csv_date_format").value, "YYYY-MM-DD")
        self.assertNotIn("last_successful_csv_mapping", fresh.session_state)

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

    def changing_app(self, contents=CUSTOM):
        """Drive the real import form across files within one Streamlit session."""
        path = str(Path(__file__).parent.resolve())
        app = AppTest.from_string(f"""
import sys
sys.path.insert(0, {path!r})
import streamlit as st
from app import render_csv_import, sample_data
if "campaign_rows" not in st.session_state:
    st.session_state.campaign_rows = sample_data()
    st.session_state.dataset_source = "sample"
    st.session_state.dataset_fingerprint = "sample"
render_csv_import(st.session_state.upload_contents, st.session_state.upload_name,
                  st.session_state.upload_fingerprint)
""")
        return self.change_upload(app, contents, "first.csv")

    def change_upload(self, app, contents, name):
        app.session_state.upload_contents = contents
        app.session_state.upload_name = name
        app.session_state.upload_fingerprint = name
        app.run()
        self.assertFalse(app.exception)
        return app

    def import_custom(self, app, revenue=None):
        for field, header in {**MAPPING, "revenue": revenue}.items():
            widget = app.selectbox(key=f"csv_mapping_{field}")
            if header is None:
                # AppTest.select(None) sends no selection; select the visible
                # first option to model choosing "Not mapped" in the browser.
                widget.select_index(0)
            else:
                widget.select(header)
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertFalse(app.error)

    def assert_choices(self, app, mapping):
        for field in ALIASES:
            self.assertEqual(app.selectbox(key=f"csv_mapping_{field}").value,
                             mapping.get(field))

    def test_matching_headers_reuse_only_after_confirmation(self):
        app = self.changing_app()
        self.import_custom(app)
        saved = app.session_state.last_successful_csv_mapping
        original = app.session_state.campaign_rows.copy()
        app.session_state.channel_filter = ["Facebook"]
        values = VALUES.copy()
        values[1] = "Second campaign"
        self.change_upload(app, csv_bytes(CUSTOM_HEADERS, values), "second.csv")
        self.assert_choices(app, MAPPING)
        self.assertIn("last successful import", app.info[0].value)
        self.assertEqual(app.dataframe[0].value.iloc[0]["Name"], "Second campaign")
        pd.testing.assert_frame_equal(app.session_state.campaign_rows, original)
        self.assertEqual(app.session_state.dataset_source, "first.csv")
        self.assertEqual(app.session_state.channel_filter, ["Facebook"])
        self.assertEqual(app.session_state.last_successful_csv_mapping, saved)
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertEqual(app.session_state.dataset_source, "second.csv")
        self.assertEqual(app.session_state.campaign_rows.iloc[0]["campaign"], "Second campaign")
        self.assertEqual(app.session_state.channel_filter, [])

    def test_reordered_headers_reuse_by_name_and_preserve_optional_choice(self):
        headers = [*CUSTOM_HEADERS, "Money"]
        values = [*VALUES, "30"]
        for revenue in (None, "Money"):
            with self.subTest(revenue=revenue):
                app = self.changing_app(csv_bytes(headers, values))
                self.import_custom(app, revenue)
                self.change_upload(app, csv_bytes(headers[::-1], values[::-1]), "reordered.csv")
                self.assert_choices(app, {**MAPPING, "revenue": revenue})
                app.button[0].click().run()
                self.assertFalse(app.exception)
                actual = app.session_state.campaign_rows.iloc[0]["revenue"]
                self.assertTrue(pd.isna(actual) if revenue is None else actual == 30)
                self.assertEqual(app.session_state.campaign_rows.iloc[0]["spend"], 10)

    def test_incompatible_headers_never_reuse_saved_choices(self):
        cases = [
            (["when", *CUSTOM_HEADERS[1:]], VALUES),
            ([*CUSTOM_HEADERS, "Extra"], [*VALUES, "ignored"]),
            (CUSTOM_HEADERS[:-1], VALUES[:-1]),
            (list(REQUIRED), VALUES),
        ]
        for headers, values in cases:
            with self.subTest(headers=headers):
                app = self.changing_app()
                self.import_custom(app)
                saved = app.session_state.last_successful_csv_mapping
                self.change_upload(app, csv_bytes(headers, values), "incompatible.csv")
                self.assert_choices(app, suggest_mapping(read_upload(csv_bytes(headers, values))))
                self.assertFalse(app.info)
                self.assertEqual(app.session_state.dataset_source, "first.csv")
                self.assertEqual(app.session_state.last_successful_csv_mapping, saved)

    def test_failed_reused_mapping_preserves_data_filters_and_saved_mapping(self):
        app = self.changing_app()
        self.import_custom(app)
        saved = app.session_state.last_successful_csv_mapping
        original = app.session_state.campaign_rows.copy()
        app.session_state.goal_filter = ["Sales"]
        values = VALUES.copy()
        values[5] = "-10"
        self.change_upload(app, csv_bytes(CUSTOM_HEADERS, values), "invalid.csv")
        app.button[0].click().run()
        self.assertIn("spend must", app.error[0].value)
        # Editing reused defaults must still reject duplicate column assignments.
        app.selectbox(key="csv_mapping_spend").select("Visits")
        app.button[0].click().run()
        self.assertIn("only one field", app.error[0].value)
        self.assertEqual(app.session_state.last_successful_csv_mapping, saved)
        self.assertEqual(app.session_state.dataset_source, "first.csv")
        self.assertEqual(app.session_state.dataset_fingerprint, "first.csv")
        self.assertEqual(app.session_state.goal_filter, ["Sales"])
        pd.testing.assert_frame_equal(app.session_state.campaign_rows, original)
        self.change_upload(app, CUSTOM, "retry.csv")
        self.assert_choices(app, MAPPING)
        # Even a malformed file must not discard the remembered successful mapping.
        self.change_upload(app, b"a,b\n1\n", "malformed.csv")
        self.assertTrue(app.error)
        self.assertEqual(app.session_state.last_successful_csv_mapping, saved)

    def test_successful_edits_replace_last_mapping_but_pending_edits_do_not(self):
        headers = [*CUSTOM_HEADERS, "Money"]
        values = [*VALUES, "30"]
        contents = csv_bytes(headers, values)
        app = self.changing_app(contents)
        self.import_custom(app, "Money")
        self.change_upload(app, contents, "pending.csv")
        app.selectbox(key="csv_mapping_revenue").select_index(0).run()
        self.change_upload(app, contents, "next.csv")
        self.assert_choices(app, {**MAPPING, "revenue": "Money"})
        app.selectbox(key="csv_mapping_revenue").select_index(0)
        app.button[0].click().run()
        self.change_upload(app, contents, "final.csv")
        self.assert_choices(app, MAPPING)
        # A successful incompatible schema replaces (rather than accumulates) mappings.
        self.change_upload(app, csv_bytes(REQUIRED, VALUES), "canonical.csv")
        app.button[0].click().run()
        self.assertFalse(app.error)
        self.change_upload(app, contents, "old-schema.csv")
        self.assert_choices(app, suggest_mapping(read_upload(contents)))

    def test_mapping_is_not_shared_with_new_session(self):
        first = self.changing_app()
        self.import_custom(first)
        second = self.changing_app()
        self.assert_choices(second, {})
        self.assertNotIn("last_successful_csv_mapping", second.session_state)
        self.assertFalse(second.info)

    def test_preview_failure_retry_and_success(self):
        app = self.app()
        original = app.session_state.campaign_rows.copy()
        self.assertFalse(app.exception)
        self.assertEqual(len(app.selectbox), len(ALIASES) + 1)
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
        self.assertEqual(app.session_state.date_filter,
                         (pd.Timestamp("2026-09-01").date(),) * 2)
        for key in ("channel_filter", "audience_filter", "goal_filter"):
            self.assertEqual(app.session_state[key], [])

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
