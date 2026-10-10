from __future__ import annotations

import csv
from datetime import date, timedelta
from io import StringIO
from math import isfinite, sin
from typing import Any

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st
from plotly.subplots import make_subplots

CHANNELS = ("Facebook", "Instagram", "Pinterest", "Twitter")
REQUIRED = ("date", "campaign", "channel", "audience", "goal", "spend", "clicks", "conversions")
ALIASES = {
    "date": ("date", "day", "report_date"),
    "campaign": ("campaign", "campaign_name"),
    "channel": ("channel", "platform"),
    "audience": ("audience", "target_audience", "audience_segment"),
    "goal": ("goal", "campaign_goal", "objective"),
    "spend": ("spend", "cost", "ad_spend", "amount_spent"),
    "clicks": ("clicks", "total_clicks"),
    "conversions": ("conversions", "total_conversions"),
    "revenue": ("revenue", "conversion_value", "sales"),
}
DATE_FORMATS = {
    "YYYY-MM-DD": ("%Y-%m-%d", r"[0-9]{4}-[0-9]{2}-[0-9]{2}"),
    "MM/DD/YYYY": ("%m/%d/%Y", r"[0-9]{2}/[0-9]{2}/[0-9]{4}"),
    "DD/MM/YYYY": ("%d/%m/%Y", r"[0-9]{2}/[0-9]{2}/[0-9]{4}"),
    "YYYY/MM/DD": ("%Y/%m/%d", r"[0-9]{4}/[0-9]{2}/[0-9]{2}"),
    "MM-DD-YYYY": ("%m-%d-%Y", r"[0-9]{2}-[0-9]{2}-[0-9]{4}"),
    "DD-MM-YYYY": ("%d-%m-%Y", r"[0-9]{2}-[0-9]{2}-[0-9]{4}"),
}


def sample_data() -> pd.DataFrame:
    """Return the same 720-row illustrative dataset as the original dashboard."""
    platforms = list(CHANNELS)
    names = ["Summer collection", "Always-on retargeting", "New customer discovery"]
    audiences = ["Adults 25–44", "Returning customers", "Adults 18–34"]
    goals = ["Sales", "Sales", "Lead generation"]
    rates = [0.041, 0.048, 0.033, 0.022]
    rows: list[dict[str, Any]] = []
    for day in range(60):
        for platform, channel in enumerate(platforms):
            for campaign, name in enumerate(names):
                current_date = date(2026, 8, 1) + timedelta(days=day)
                wave = 1 + 0.18 * sin(day / 5 + platform) + day * 0.005
                spend = int((110 + platform * 27 + campaign * 40) * wave * 100 + 0.5) / 100
                clicks = int(spend * (3.7 - platform * 0.45) + ((day * 19 + campaign * 11) % 47) + 0.5)
                conversions = int(clicks * rates[platform] * (1.4 if campaign == 1 else 1) + 0.5)
                rows.append({
                    "date": pd.Timestamp(current_date),
                    "campaign": name,
                    "channel": channel,
                    "audience": audiences[campaign],
                    "goal": goals[campaign],
                    "spend": spend,
                    "clicks": clicks,
                    "conversions": conversions,
                    "revenue": conversions * (32 + campaign * 7),
                })
    return pd.DataFrame(rows)


def normalize_header(column: str) -> str:
    return column.strip().lower().replace("-", "_").replace(" ", "_")


def read_upload(contents: bytes) -> pd.DataFrame:
    """Read a CSV for preview without changing its original headers or values."""
    if len(contents) > 5 * 1024 * 1024:
        raise ValueError("CSV must be 5 MB or smaller.")
    try:
        text = contents.decode("utf-8-sig")
        records = [record for record in csv.reader(StringIO(text), strict=True) if any(cell.strip() for cell in record)]
        if len(records) < 2:
            raise ValueError("CSV needs a header and at least one data row.")
        headers = records[0]
        normalized = [normalize_header(column) for column in headers]
        if any(not column for column in normalized):
            raise ValueError("CSV column names cannot be blank.")
        if len(set(normalized)) != len(headers):
            raise ValueError("CSV contains duplicate column names.")
        if any(len(record) != len(headers) for record in records[1:]):
            raise ValueError("Every CSV row must have the same number of columns as the header.")
        frame = pd.DataFrame(records[1:], columns=headers)
    except UnicodeDecodeError as exc:
        raise ValueError("The CSV must use UTF-8 text encoding.") from exc
    except Exception as exc:
        raise ValueError(f"Could not read the CSV: {exc}") from exc
    if frame.empty:
        raise ValueError("CSV needs a header and at least one data row.")
    if len(frame) > 50_000:
        raise ValueError("CSV must contain no more than 50,000 data rows.")

    return frame


def suggest_mapping(frame: pd.DataFrame) -> dict[str, str | None]:
    """Suggest only unambiguous supported aliases; do not infer export schemas."""
    mapping: dict[str, str | None] = {}
    for canonical, options in ALIASES.items():
        matches = [column for column in frame.columns if normalize_header(column) in options]
        mapping[canonical] = matches[0] if len(matches) == 1 else None
    return mapping


def interpret_dates(values: pd.Series, date_format: str) -> pd.Series:
    """Use the same strict date interpretation for preview and final validation."""
    parser_format, pattern = DATE_FORMATS[date_format]
    cleaned = values.astype(str).str.strip()
    parsed = pd.to_datetime(cleaned, format=parser_format, errors="coerce", exact=True)
    return parsed.where(cleaned.str.fullmatch(pattern))


def interpreted_date_preview(values: pd.Series, date_format: str) -> pd.DataFrame:
    """Return a small, non-committing comparison without altering CSV values."""
    sample = values.head(10)
    return pd.DataFrame({
        "CSV row": sample.index + 2,
        "Original date": sample,
        "Interpreted date (YYYY-MM-DD)": interpret_dates(sample, date_format)
        .dt.strftime("%Y-%m-%d").fillna("Invalid date"),
    })


def validate_upload(
    frame: pd.DataFrame,
    mapping: dict[str, str | None],
    date_format: str = "YYYY-MM-DD",
) -> pd.DataFrame:
    """Project explicitly selected columns, then apply the same strict value rules."""
    if date_format not in DATE_FORMATS:
        raise ValueError(f"Unsupported date format. Choose one of: {', '.join(DATE_FORMATS)}.")
    unknown = set(mapping) - set(ALIASES)
    if unknown:
        raise ValueError(f"Unknown mapping fields: {', '.join(sorted(unknown))}.")
    missing = [key for key in REQUIRED if mapping.get(key) is None]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}. Map each required field to a CSV column. Revenue is optional.")
    selected = [column for column in mapping.values() if column is not None]
    if any(column not in frame.columns for column in selected):
        raise ValueError("Every mapped column must exist in the uploaded CSV.")
    if len(set(selected)) != len(selected):
        raise ValueError("Each CSV column can be mapped to only one field.")
    frame = pd.DataFrame({
        key: frame[mapping[key]].copy() if mapping.get(key) is not None else ""
        for key in ALIASES
    }, index=frame.index)

    for column in ("date", "campaign", "channel", "audience", "goal"):
        frame[column] = frame[column].astype(str).str.strip()
        if frame[column].eq("").any():
            row = int(frame.index[frame[column].eq("")][0]) + 2
            raise ValueError(f"Row {row}: {column} cannot be blank.")

    parsed_dates = interpret_dates(frame["date"], date_format)
    bad_dates = parsed_dates.isna()
    if bad_dates.any():
        raise ValueError(
            f"Row {int(frame.index[bad_dates][0]) + 2}: date must be a valid {date_format} date. "
            "Every row must use the selected format; month/day order is never guessed."
        )
    frame["date"] = parsed_dates

    channel_map = {
        "facebook": "Facebook", "instagram": "Instagram", "pinterest": "Pinterest",
        "twitter": "Twitter", "x": "Twitter",
    }
    frame["channel"] = frame["channel"].str.lower().map(channel_map)
    if frame["channel"].isna().any():
        raise ValueError(f"Channel must be Facebook, Instagram, Pinterest, or Twitter (X). Invalid value on row {int(frame.index[frame['channel'].isna()][0]) + 2}.")

    for column in ("spend", "clicks", "conversions", "revenue"):
        cleaned = frame[column].astype(str).str.replace(r"[$,\s]", "", regex=True)
        blank = cleaned.eq("")
        if column == "revenue":
            frame[column] = pd.to_numeric(cleaned.mask(blank), errors="coerce")
            invalid = ~blank & frame[column].isna()
        else:
            frame[column] = pd.to_numeric(cleaned, errors="coerce")
            invalid = frame[column].isna()
        invalid |= frame[column].notna() & (frame[column] < 0)
        invalid |= frame[column].notna() & frame[column].map(lambda value: not isfinite(value) or value > 9_007_199_254_740_991)
        if invalid.any():
            raise ValueError(f"Row {int(frame.index[invalid][0]) + 2}: {column} must be a non-negative number.")
        if column in ("clicks", "conversions"):
            fractional = frame[column].notna() & (frame[column] % 1 != 0)
            if fractional.any():
                raise ValueError(f"Row {int(frame.index[fractional][0]) + 2}: {column} must be a whole-number count.")
    return frame[list(REQUIRED) + ["revenue"]]


def parse_upload(
    contents: bytes,
    mapping: dict[str, str | None] | None = None,
    date_format: str = "YYYY-MM-DD",
) -> pd.DataFrame:
    frame = read_upload(contents)
    return validate_upload(frame, suggest_mapping(frame) if mapping is None else mapping, date_format)


def render_csv_import(contents: bytes, name: str, fingerprint: str) -> None:
    """Stage an upload; commit data and reset filters only after a valid submission."""
    if st.session_state.get("mapping_fingerprint") != fingerprint:
        for field in ALIASES:
            st.session_state.pop(f"csv_mapping_{field}", None)
        # Matching headers cannot establish a new file's month/day order.
        st.session_state.pop("csv_date_format", None)
        st.session_state.mapping_fingerprint = fingerprint
    try:
        preview = read_upload(contents)
    except ValueError as exc:
        st.error(str(exc))
        st.caption("Import failed. Your current dataset and filters are unchanged.")
        return

    st.subheader("Preview and map columns")
    st.caption(f"{len(preview):,} rows · showing the first 10 with original CSV headers.")
    st.dataframe(preview.head(10), hide_index=True, width="stretch")
    st.caption(
        "Choose one CSV column per field. Recognized aliases are suggested; "
        "unrecognized or ambiguous headers need your selection. "
        "All amounts must be USD. Data stays in this session only."
    )
    st.caption(
        "Choose the date format used in every row; month/day order is never guessed. "
        "Channels must be Facebook, Instagram, Pinterest, "
        "or Twitter (X). Campaign, audience, and goal must be present in the CSV; "
        "missing metadata is not generated. Unmapped columns are ignored."
    )
    suggestions = suggest_mapping(preview)
    # Match every original header (including ignored columns), not normalized
    # aliases. Column order can change because mappings refer to names.
    headers = frozenset(preview.columns)
    saved = st.session_state.get("last_successful_csv_mapping")
    if saved is not None and saved["headers"] == headers:
        suggestions = saved["mapping"].copy()
        st.info(
            "Column choices from your last successful import are prefilled for "
            "these matching headers. Review or edit them, then select Import mapped CSV. "
            "Your current data stays unchanged until you confirm a valid import."
        )
    options = [None, *preview.columns]
    mapping: dict[str, str | None] = {}
    # These controls rerun immediately so the interpretation shown above the
    # confirmation button always reflects the current mapping and date format.
    with st.container():
        for field in ALIASES:
            mapping[field] = st.selectbox(
                f"{field.title()} {'(optional)' if field == 'revenue' else '(required)'}",
                options,
                index=options.index(suggestions[field]),
                format_func=lambda value: "— Not mapped —" if value is None else value,
                key=f"csv_mapping_{field}",
            )
        date_format = st.selectbox(
            "Date format",
            list(DATE_FORMATS),
            key="csv_date_format",
            help=(
                "YYYY-MM-DD (year-month-day) is the default. "
                "YYYY/MM/DD is year/month/day. "
                "MM/DD/YYYY and MM-DD-YYYY are month-first; "
                "DD/MM/YYYY and DD-MM-YYYY are day-first. "
                "Use two-digit months and days and four-digit years, with the shown separators. "
                "Mixed formats and impossible dates are rejected. Choose again for each new file."
            ),
        )
        st.subheader("Review interpreted dates")
        st.caption(
            f"Using {date_format} · showing the first 10 dates from the selected column. "
            "Check the month/day order before importing. This preview does not change "
            "your current dataset or filters; every row is validated on confirmation."
        )
        if mapping["date"] is None:
            st.caption("Map the required Date field to see its interpreted dates.")
        else:
            st.dataframe(
                interpreted_date_preview(preview[mapping["date"]], date_format),
                hide_index=True, width="stretch",
            )
        submitted = st.button("Import mapped CSV", width="stretch")
    if submitted:
        try:
            parsed = validate_upload(preview, mapping, date_format)
        except ValueError as exc:
            st.error(str(exc))
            st.caption("Import failed. Your current dataset and filters are unchanged.")
            return
        st.session_state.last_successful_csv_mapping = {
            "headers": headers,
            "mapping": mapping.copy(),
        }
        st.session_state.campaign_rows = parsed
        st.session_state.dataset_source = name
        st.session_state.dataset_fingerprint = fingerprint
        # Explicit values update the browser's existing widgets too. Deleting
        # keys resets Python defaults but can leave keyed frontend controls stale.
        st.session_state.date_filter = (
            parsed["date"].min().date(), parsed["date"].max().date()
        )
        for key in ("channel_filter", "audience_filter", "goal_filter"):
            st.session_state[key] = []
        st.rerun()


def roi(revenue: float | None, spend: float) -> float | None:
    if revenue is None or pd.isna(revenue) or spend <= 0:
        return None
    return (float(revenue) - spend) / spend * 100


def summarize(frame: pd.DataFrame) -> dict[str, float | None]:
    spend = float(frame["spend"].sum()) if not frame.empty else 0.0
    clicks = int(frame["clicks"].sum()) if not frame.empty else 0
    conversions = int(frame["conversions"].sum()) if not frame.empty else 0
    revenue: float | None = None
    if not frame.empty and frame["revenue"].notna().all():
        revenue = float(frame["revenue"].sum())
    return {
        "spend": spend,
        "clicks": clicks,
        "conversions": conversions,
        "revenue": revenue,
        "roi": roi(revenue, spend),
        "cpc": spend / clicks if clicks else None,
        "cpa": spend / conversions if conversions else None,
        "conversion_rate": conversions / clicks * 100 if clicks else None,
    }


def metric_label(value: float | None, kind: str) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    if kind in ("spend", "revenue", "cpa", "cpc"):
        return f"${value:,.2f}"
    if kind in ("roi", "conversion_rate"):
        return f"{value:,.1f}%"
    return f"{value:,.0f}"


def grouped_metrics(frame: pd.DataFrame, by: str | list[str]) -> pd.DataFrame:
    if frame.empty:
        keys = [by] if isinstance(by, str) else by
        return pd.DataFrame(columns=keys + ["spend", "clicks", "conversions", "revenue", "roi", "cpa"])
    records = []
    for value, group in frame.groupby(by, dropna=False, sort=False):
        stats = summarize(group)
        keys = dict(zip([by] if isinstance(by, str) else by, value if isinstance(value, tuple) else (value,)))
        records.append({
            **keys,
            **stats,
            "roi": stats["roi"],
            "cpa": stats["cpa"],
        })
    return pd.DataFrame(records)


def display_table(frame: pd.DataFrame) -> Any:
    labels = {
        "channel": "Channel", "campaign": "Campaign", "audience": "Audience", "goal": "Goal",
        "spend": "Spend · USD", "clicks": "Clicks · count", "conversions": "Conversions · count",
        "revenue": "Revenue · USD", "roi": "ROI · %", "cpa": "Cost per conversion · USD",
        "cpc": "Cost per click · USD", "conversion_rate": "Conversion rate · %",
    }
    formats = {
        "Spend · USD": "${:,.2f}", "Revenue · USD": "${:,.2f}",
        "Cost per conversion · USD": "${:,.2f}", "Cost per click · USD": "${:,.2f}",
        "ROI · %": "{:,.1f}%", "Conversion rate · %": "{:,.1f}%",
        "Clicks · count": "{:,.0f}", "Conversions · count": "{:,.0f}",
    }
    display = frame.rename(columns=labels)
    return display.style.format(
        {column: value for column, value in formats.items() if column in display.columns},
        na_rep="N/A",
    )


def export_csv(frame: pd.DataFrame) -> str:
    export = frame.copy()
    for column in ("campaign", "channel", "audience", "goal"):
        if column in export.columns:
            export[column] = export[column].map(
                lambda value: "'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")) else value
            )
    return export.to_csv(index=False, date_format="%Y-%m-%d")


def empty_message() -> None:
    st.info("No campaigns match these filters. Widen the date range or clear one or more filters.")


def main() -> None:
    st.set_page_config(
        page_title="AdScope · Campaign intelligence",
        layout="wide",
        initial_sidebar_state="expanded",
    )
    st.title("AdScope")
    st.caption("Campaign intelligence · Understand what your spend is returning.")

    if "campaign_rows" not in st.session_state:
        st.session_state.campaign_rows = sample_data()
        st.session_state.dataset_source = "sample"
        st.session_state.dataset_fingerprint = "sample"

    with st.sidebar:
        st.header("Campaign data")
        uploaded = st.file_uploader("Upload campaign CSV", type=["csv"], help="Processed in memory for this Streamlit session; not saved to a database. Maximum 5 MB and 50,000 rows.")
        if uploaded is not None:
            fingerprint = f"{uploaded.name}:{uploaded.size}:{hash(uploaded.getvalue())}"
            if fingerprint != st.session_state.dataset_fingerprint:
                render_csv_import(uploaded.getvalue(), uploaded.name, fingerprint)
            else:
                st.success(f"Imported {uploaded.name}.")
        st.download_button(
            "Download sample CSV",
            data=sample_data().to_csv(index=False, date_format="%Y-%m-%d"),
            file_name="adscope-sample.csv",
            mime="text/csv",
            width="stretch",
        )
        st.caption(f"Current dataset: {st.session_state.dataset_source}")
        with st.expander("CSV format"):
            st.write("Required columns: date, campaign, channel, audience, goal, spend, clicks, conversions.")
            st.write("Preview your CSV and map its existing headers to these fields before importing. No file renaming is needed.")
            st.write(
                "Revenue is optional. Dates default to YYYY-MM-DD; other supported formats are "
                f"{', '.join(list(DATE_FORMATS)[1:])}. Select your format in the mapping form. "
                "Use four-digit years and two-digit months/days with the shown separators. "
                "Every row must use the selected format; dates are never guessed. "
                "Use non-negative amounts and whole-number click/conversion counts. "
                "All monetary data must use USD."
            )
            st.write("Channels: Facebook, Instagram, Pinterest, Twitter (X). Each row represents one campaign-day record.")
        st.divider()

        rows: pd.DataFrame = st.session_state.campaign_rows
        min_date = rows["date"].min().date()
        max_date = rows["date"].max().date()
        if "date_filter" not in st.session_state:
            st.session_state.date_filter = (min_date, max_date)
        picked_dates = st.date_input(
            "Date range · inclusive",
            min_value=min_date,
            max_value=max_date,
            key="date_filter",
        )
        selected_channels = st.multiselect(
            "Channel", sorted(rows["channel"].unique()), key="channel_filter",
        )
        selected_audiences = st.multiselect(
            "Audience", sorted(rows["audience"].unique()), key="audience_filter",
        )
        selected_goals = st.multiselect(
            "Campaign goal", sorted(rows["goal"].unique()), key="goal_filter",
        )
        def clear_filters() -> None:
            st.session_state.date_filter = (min_date, max_date)
            st.session_state.channel_filter = []
            st.session_state.audience_filter = []
            st.session_state.goal_filter = []
        st.button("Clear filters", on_click=clear_filters, width="stretch")
        st.caption("Currency values are interpreted as USD. CSV data remains in this session only.")

    if isinstance(picked_dates, (tuple, list)):
        if len(picked_dates) == 2:
            date_start, date_end = picked_dates
        elif len(picked_dates) == 1:
            date_start = date_end = picked_dates[0]
        else:
            date_start, date_end = min_date, max_date
    else:
        date_start = date_end = picked_dates
    filtered = rows[
        (rows["date"].dt.date >= date_start)
        & (rows["date"].dt.date <= date_end)
    ].copy()
    if selected_channels:
        filtered = filtered[filtered["channel"].isin(selected_channels)]
    if selected_audiences:
        filtered = filtered[filtered["audience"].isin(selected_audiences)]
    if selected_goals:
        filtered = filtered[filtered["goal"].isin(selected_goals)]

    st.caption(f"{len(filtered):,} of {len(rows):,} campaign-day records")
    if not filtered.empty and filtered["revenue"].isna().any():
        st.warning("Revenue and ROI are unavailable for this selection because one or more rows have missing revenue. Add complete revenue data to calculate ROI as (revenue − spend) ÷ spend.")
    stats = summarize(filtered)

    overview, platform, campaigns, timeseries = st.tabs(
        ["Overview", "Platform Comparison", "Campaign Details", "Time Series"]
    )

    with overview:
        st.subheader("Performance snapshot")
        if filtered.empty:
            empty_message()
        else:
            cards = st.columns(4)
            cards[0].metric("Spend · USD", metric_label(stats["spend"], "spend"))
            cards[1].metric("Clicks · count", metric_label(stats["clicks"], "clicks"))
            cards[2].metric("Conversions · count", metric_label(stats["conversions"], "conversions"))
            cards[3].metric("ROI · %", metric_label(stats["roi"], "roi"), help="(Total revenue − total spend) ÷ total spend × 100. Requires revenue on every included row.")

            daily = filtered.groupby("date", as_index=False).agg(
                spend=("spend", "sum"), conversions=("conversions", "sum")
            )
            figure = make_subplots(specs=[[{"secondary_y": True}]])
            figure.add_trace(
                go.Bar(x=daily["date"], y=daily["spend"], name="Spend · USD", marker_color="#b9613d"),
                secondary_y=False,
            )
            figure.add_trace(
                go.Scatter(x=daily["date"], y=daily["conversions"], name="Conversions · count", mode="lines+markers", line={"color": "#397a69", "width": 2.5}),
                secondary_y=True,
            )
            figure.update_layout(
                title="Spend against conversions",
                hovermode="x unified",
                legend={"orientation": "h", "y": 1.12},
                margin={"t": 70, "r": 25, "b": 25, "l": 25},
            )
            figure.update_yaxes(title_text="Spend (USD)", rangemode="tozero", secondary_y=False)
            figure.update_yaxes(title_text="Conversions (count)", rangemode="tozero", secondary_y=True)
            st.plotly_chart(figure, width="stretch")
            st.subheader("Campaign snapshot")
            st.dataframe(
                display_table(grouped_metrics(filtered, ["channel", "campaign"]).sort_values("spend", ascending=False).head(8)),
                hide_index=True, width="stretch",
            )

    with platform:
        st.subheader("Channel performance")
        if filtered.empty:
            empty_message()
        else:
            grouped = grouped_metrics(filtered, "channel").sort_values("spend", ascending=False)
            cards = st.columns(4)
            cards[0].metric("Total spend · USD", metric_label(stats["spend"], "spend"))
            cards[1].metric("Total clicks · count", metric_label(stats["clicks"], "clicks"))
            cards[2].metric("Total conversions · count", metric_label(stats["conversions"], "conversions"))
            cards[3].metric("Total ROI · %", metric_label(stats["roi"], "roi"))
            figure = make_subplots(rows=1, cols=2, subplot_titles=("Spend · USD", "Conversions · count"))
            figure.add_trace(go.Bar(x=grouped["channel"], y=grouped["spend"], name="Spend (USD)", marker_color="#b9613d"), row=1, col=1)
            figure.add_trace(go.Bar(x=grouped["channel"], y=grouped["conversions"], name="Conversions (count)", marker_color="#397a69"), row=1, col=2)
            figure.update_yaxes(title_text="USD", rangemode="tozero", row=1, col=1)
            figure.update_yaxes(title_text="Count", rangemode="tozero", row=1, col=2)
            figure.update_layout(showlegend=False, margin={"t": 65, "b": 20})
            st.plotly_chart(figure, width="stretch")
            st.dataframe(display_table(grouped), hide_index=True, width="stretch")

    with campaigns:
        st.subheader("Campaign details")
        if filtered.empty:
            empty_message()
        else:
            search = st.text_input("Search campaigns", placeholder="Campaign, channel, audience, or goal")
            detail = filtered.copy()
            if search.strip():
                needle = search.strip().casefold()
                search_cols = detail[["campaign", "channel", "audience", "goal"]].astype(str)
                matches = search_cols.apply(lambda col: col.str.casefold().str.contains(needle, regex=False)).any(axis=1)
                detail = detail[matches]
            grouped = grouped_metrics(detail, ["channel", "campaign"])
            if grouped.empty:
                st.info("No campaign matches your search. Try another search term.")
            else:
                meta = detail.groupby(["channel", "campaign"], as_index=False).agg(
                    audiences=("audience", lambda s: ", ".join(sorted(s.unique()))),
                    goals=("goal", lambda s: ", ".join(sorted(s.unique()))),
                )
                table = grouped.merge(meta, on=["channel", "campaign"], how="left").sort_values("spend", ascending=False)
                st.dataframe(display_table(table), hide_index=True, width="stretch")
            st.caption("Export includes all campaign-day records matching the date, channel, audience, and goal filters. Campaign search only affects the table, not the CSV.")
            st.download_button(
                "Export filtered CSV",
                data=export_csv(filtered),
                file_name="adscope-filtered-campaigns.csv",
                mime="text/csv",
            )

    with timeseries:
        st.subheader("Performance over time")
        if filtered.empty:
            empty_message()
        else:
            controls = st.columns([1, 2, 3])
            interval = controls[0].selectbox("Group by", ["Daily", "Weekly", "Monthly"])
            metric = controls[1].selectbox(
                "Metric",
                ["Spend · USD", "Clicks · count", "Conversions · count", "Revenue · USD", "ROI · %"],
            )
            frequency = {"Daily": "D", "Weekly": "W-MON", "Monthly": "MS"}[interval]
            value_column = {
                "Spend · USD": "spend", "Clicks · count": "clicks",
                "Conversions · count": "conversions", "Revenue · USD": "revenue",
            }.get(metric)
            if metric == "ROI · %":
                grouped_rows = filtered.set_index("date").resample(frequency, label="left", closed="left").agg(
                    spend=("spend", "sum"), revenue=("revenue", lambda values: values.sum(min_count=len(values))),
                ).dropna(subset=["spend"])
                grouped_rows["value"] = grouped_rows.apply(
                    lambda row: roi(row["revenue"], row["spend"]), axis=1
                )
            else:
                assert value_column is not None
                grouped_rows = filtered.set_index("date").resample(frequency, label="left", closed="left").agg(
                    value=(value_column, lambda values: values.sum(min_count=len(values)) if value_column == "revenue" else values.sum())
                )
            title, unit = metric.split(" · ")
            figure = px.area(
                grouped_rows.reset_index(), x="date", y="value",
                labels={"date": "Date", "value": f"{title} ({unit})"},
                title=f"{title} by {interval.lower()} period",
                color_discrete_sequence=["#b9613d"],
            )
            figure.update_traces(hovertemplate="%{x|%b %d, %Y}<br>%{y:,.2f}<extra></extra>")
            if metric != "ROI · %":
                figure.update_yaxes(rangemode="tozero")
            figure.update_layout(hovermode="x unified", margin={"t": 65, "b": 20})
            st.plotly_chart(figure, width="stretch")

    st.caption("Sample data is illustrative. All monetary values are shown in USD. ROI uses (revenue − spend) ÷ spend; it is unavailable when revenue is missing.")


if __name__ == "__main__":
    main()
