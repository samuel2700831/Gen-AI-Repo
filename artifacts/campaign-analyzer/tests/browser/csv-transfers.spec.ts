import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { expect, test, type Locator, type Page } from "@playwright/test";

const fixture = fileURLToPath(new URL("../fixtures/aliased_campaigns.csv", import.meta.url));
const columns = ["date", "campaign", "channel", "audience", "goal", "spend", "clicks", "conversions", "revenue"];
type Row = Record<string, string>;

// Hand-authored expectations: never compute the oracle by importing app.py.
const imported: Row[] = [
  ["2026-08-31", "Launch", "Facebook", "Adults", "Sales", "10", "10", "1", "30"],
  ["2026-09-01", "Launch", "Facebook", "Adults", "Sales", "90", "30", "9", "90"],
  ["2026-09-06", "Discovery", "Instagram", "Students", "Leads", "20", "20", "2", "40"],
  ["2026-09-07", "Retarget", "Pinterest", "Adults", "Sales", "0", "0", "0", "0"],
  ["2026-10-01", "Discovery", "Twitter", "Students", "Leads", "50", "25", "5", ""],
  ["2026-10-05", "Launch", "Facebook", "Adults", "Sales", "100", "50", "10", "300"],
].map(values => Object.fromEntries(columns.map((column, index) => [column, values[index]])));

async function recordCount(page: Page, shown: number, total: number) {
  await expect(page.getByText(`${shown} of ${total} campaign-day records`, { exact: true })).toBeVisible();
}

async function transfer(page: Page, file: Parameters<ReturnType<Page["locator"]>["setInputFiles"]>[0]) {
  const transport = page.waitForResponse(response =>
    response.request().method() === "PUT" && response.url().includes("/_stcore/upload_file/"));
  // This uses the native input, not AppTest/session state or an HTTP mock.
  await page.locator('input[type="file"]').setInputFiles(file);
  expect((await transport).ok()).toBe(true);
}

async function upload(page: Page, file: Parameters<ReturnType<Page["locator"]>["setInputFiles"]>[0]) {
  await transfer(page, file);
  await expect(page.getByRole("heading", { name: "Preview and map columns", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import mapped CSV", exact: true })).toBeVisible();
}

async function confirm(page: Page, filename: string, count: number) {
  await page.getByRole("button", { name: "Import mapped CSV", exact: true }).click();
  await expect(page.getByText(`Imported ${filename}.`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Current dataset: ${filename}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import mapped CSV", exact: true })).toHaveCount(0);
  await recordCount(page, count, count);
}

async function download(page: Page, label: string, filename: string): Promise<Row[]> {
  const button = page.getByRole("button", { name: label, exact: true });
  await expect(button).toHaveCount(1);
  await expect(button).toBeEnabled();
  const event = page.waitForEvent("download");
  await button.click();
  const result = await event;
  expect(result.suggestedFilename()).toBe(filename);
  expect(await result.failure()).toBeNull();
  const path = await result.path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  expect(bytes.length).toBeGreaterThan(0);
  const records: string[][] = parse(bytes, { bom: true, skip_empty_lines: true });
  expect(records.shift()).toEqual(columns);
  return records.map(values => {
    expect(values).toHaveLength(columns.length);
    return Object.fromEntries(columns.map((column, index) => {
      const value = values[index];
      // Compare numeric contents, not pandas' choice of integer/float spelling.
      if (index >= 5 && value !== "") {
        expect(value).toMatch(/^\d+(?:\.\d+)?$/);
        expect(Number.isFinite(Number(value))).toBe(true);
        return [column, String(Number(value))];
      }
      return [column, value];
    }));
  });
}

async function exported(page: Page): Promise<Row[]> {
  const tab = page.getByRole("tab", { name: "Campaign Details", exact: true });
  // A rerun can briefly retain old and new tab trees after the count updates.
  // Wait for reconciliation instead of clicking a stale copy or sleeping.
  await expect(tab).toHaveCount(1);
  await tab.click();
  return download(page, "Export filtered CSV", "adscope-filtered-campaigns.csv");
}

async function choose(page: Page, label: string, option: string) {
  const control = page.getByRole("combobox", { name: label, exact: true });
  await control.click();
  // Metadata fixtures make long, virtualized option lists. Native typing
  // brings the requested value into view without relying on list position.
  await control.fill(option);
  await page.getByRole("option", { name: option, exact: true }).click();
  await page.keyboard.press("Escape");
}

async function dateBoundary(page: Page, boundary: "start" | "end", month: number, day: number) {
  // Streamlit's segmented date field: interact with visible accessible controls,
  // never its hidden backing input or the session state.
  for (const [segment, value] of [["day", day], ["month", month]] as const) {
    const control = page.getByRole("spinbutton", {
      name: `${segment}, Date range · inclusive ${boundary} date`, exact: true,
    });
    await control.fill(String(value));
    await control.press("Tab");
    await expect(control).toHaveAttribute("aria-valuenow", String(value));
  }
}

async function openView(page: Page, name: string) {
  const tab = page.getByRole("tab", { name, exact: true });
  await expect(tab).toHaveCount(1);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  return page.getByRole("tabpanel", { name, exact: true });
}

type Interval = "Daily" | "Weekly" | "Monthly";
const seriesMetrics = ["Spend · USD", "Clicks · count", "Conversions · count", "Revenue · USD", "ROI · %"] as const;
type SeriesMetric = typeof seriesMetrics[number];
type Bucket = [number, number, number, number | null, number | null];

// Golden totals from the six calculation records, including empty periods.
// No app calculation, exported result, or chart output supplies these oracles.
const dailyDates = [
  "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05",
  "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11",
  "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17",
  "2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23",
  "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29",
  "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
];
const dailyRecords: Record<string, Bucket> = {
  "2026-08-31": [10, 10, 1, 30, 200],
  "2026-09-01": [90, 30, 9, 90, 0],
  "2026-09-06": [20, 20, 2, 40, 100],
  "2026-09-07": [0, 0, 0, 0, null],
  "2026-10-01": [50, 25, 5, null, null],
  "2026-10-05": [100, 50, 10, 300, 200],
};
const seriesGolden: Record<Interval, { dates: string[]; buckets: Bucket[] }> = {
  Daily: {
    dates: dailyDates,
    buckets: dailyDates.map(date => dailyRecords[date] ?? [0, 0, 0, 0, null]),
  },
  Weekly: {
    dates: ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"],
    buckets: [
      [120, 60, 12, 160, 100 / 3], [0, 0, 0, 0, null],
      [0, 0, 0, 0, null], [0, 0, 0, 0, null],
      [50, 25, 5, null, null], [100, 50, 10, 300, 200],
    ],
  },
  Monthly: {
    dates: ["2026-08-01", "2026-09-01", "2026-10-01"],
    buckets: [[10, 10, 1, 30, 200], [110, 50, 11, 130, 200 / 11], [150, 75, 15, null, null]],
  },
};

async function selectSeries(page: Page, label: "Group by" | "Metric", value: string) {
  const panel = await openView(page, "Time Series");
  const widget = panel.getByTestId("stSelectbox").filter({
    has: page.getByText(label, { exact: true }),
  });
  await expect(widget).toHaveCount(1);
  await widget.getByRole("combobox").click();
  await page.getByRole("option", { name: value, exact: true }).click();
  await expect(widget.getByRole("combobox")).toHaveValue(value);
}

async function assertSeries(
  page: Page, interval: Interval, metric: SeriesMetric,
  dates: string[], values: (number | null)[],
) {
  const panel = await openView(page, "Time Series");
  for (const [label, value] of [["Group by", interval], ["Metric", metric]]) {
    const widget = panel.getByTestId("stSelectbox").filter({
      has: page.getByText(label, { exact: true }),
    });
    await expect(widget).toHaveCount(1);
    await expect(widget.getByRole("combobox")).toHaveValue(value);
  }
  const chart = panel.locator(".js-plotly-plot");
  await expect(chart).toHaveCount(1);
  const [title, unit] = metric.split(" · ");
  // Poll the actual rendered Plotly trace through Streamlit's asynchronous rerun.
  // Do not mistake a changed selectbox for a finished chart update.
  await expect.poll(async () => {
    const rendered = await chart.evaluate(element => {
      const figure = element as HTMLElement & {
        _fullData: { x: string[]; y: ArrayLike<number | null>; type: string; mode: string }[];
        layout: { title: { text: string }; xaxis: { title: { text: string } }; yaxis: { title: { text: string } } };
      };
      // Plotly's resolved render traces contain decoded numeric arrays; input
      // data can still contain the transport's base64 typed-array descriptors.
      const trace = figure._fullData[0];
      // Streamlit's Plotly theme adds bold HTML around the title. Compare the
      // displayed wording, not the theme's nested formatting tags.
      const titleText = document.createElement("div");
      titleText.innerHTML = figure.layout.title.text;
      return {
        traces: figure._fullData.length,
        dates: Array.from(trace.x, value => value.slice(0, 10)),
        values: Array.from(trace.y, value =>
          value === null || Number.isNaN(value) ? null : Number(value.toFixed(8))),
        type: trace.type, mode: trace.mode,
        title: titleText.textContent,
        xLabel: figure.layout.xaxis.title.text,
        yLabel: figure.layout.yaxis.title.text,
      };
    });
    return rendered;
  }).toEqual({
    traces: 1, dates, type: "scatter", mode: "lines",
    title: `${title} by ${interval.toLowerCase()} period`,
    xLabel: "Date", yLabel: `${title} (${unit})`,
    values: values.map(value => value === null ? null : Number(value.toFixed(8))),
  });
}

async function gridContents(page: Page, scope: Page | Locator = page) {
  // Glide exposes its accessible table when the native canvas has focus.
  // Read rendered cells, not React internals or seeded Streamlit state.
  const canvas = scope.getByTestId("data-grid-canvas").filter({ visible: true });
  await expect(canvas).toHaveCount(1);
  await canvas.focus();
  await canvas.press("ArrowDown");
  // Canvas fallback content is not considered visible by locator role queries.
  const grid = canvas.getByRole("grid", { includeHidden: true });
  await expect(grid).toHaveCount(1);
  return {
    count: await grid.getAttribute("aria-rowcount"),
    headers: await grid.getByRole("columnheader", { includeHidden: true }).evaluateAll(
      cells => cells.map(cell => cell.textContent)),
    rows: await grid.locator("tbody tr").evaluateAll(
      rows => rows.map(row => Array.from(row.querySelectorAll("td"), cell => cell.textContent))),
  };
}

async function otherViews(page: Page) {
  const views = [];
  for (const name of ["Overview", "Platform Comparison", "Time Series"]) {
    const panel = await openView(page, name);
    const chart = panel.locator(".js-plotly-plot");
    await expect(chart).toHaveCount(1);
    const plot = await chart.evaluate(element => {
      const figure = element as HTMLElement & {
        data: Record<string, unknown>[];
        layout: Record<string, unknown>;
      };
      // Ignore generated Plotly ids; compare the rendered trace data and titles.
      return JSON.stringify({
        traces: figure.data.map(({ x, y, name, type, mode }) => ({ x, y, name, type, mode })),
        title: figure.layout.title,
      });
    });
    views.push({
      name,
      metrics: await panel.getByTestId("stMetric").allTextContents(),
      table: name === "Time Series" ? null : await gridContents(page),
      plot,
      controls: await panel.getByRole("combobox").allTextContents(),
    });
  }
  return {
    views,
    filters: await page.getByTestId("stMultiSelectTagsContainer").allTextContents(),
    dates: await page.getByRole("spinbutton").evaluateAll(
      controls => controls.map(control => [control.getAttribute("aria-label"), control.getAttribute("aria-valuenow")])),
    records: await page.getByText(/^\d+ of \d+ campaign-day records$/).textContent(),
  };
}

function displayedSpend(value: string | null) {
  // Glide's accessible fallback currently exposes raw numbers even when the
  // visual column is currency-formatted. Validate either representation before
  // parsing so "$30.75" cannot become NaN and malformed cells cannot pass.
  expect(value).toMatch(/^(?:\d+(?:\.\d+)?|\$(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/);
  return Number(value!.replace(/[$,]/g, ""));
}

async function searchFor(page: Page, query: string, expected: [string, string, number][]) {
  const panel = await openView(page, "Campaign Details");
  const search = panel.getByRole("textbox", { name: "Search campaigns", exact: true });
  await expect(search).toHaveCount(1);
  await search.fill(query);
  await search.press("Enter");
  await expect(search).toHaveValue(query);
  const empty = panel.getByText("No campaign matches your search. Try another search term.", { exact: true });
  if (expected.length === 0) {
    await expect(empty).toBeVisible();
    await expect(panel.getByTestId("stDataFrame")).toHaveCount(0);
  } else {
    await expect(empty).toHaveCount(0);
    await expect.poll(async () => {
      const grid = await gridContents(page);
      expect(grid.headers.slice(0, 3)).toEqual(["Channel", "Campaign", "Spend · USD"]);
      return { count: grid.count, rows: grid.rows.map(row => [row[0], row[1], displayedSpend(row[2])]) };
    }).toEqual({ count: String(expected.length + 1), rows: expected });
  }
  await expect(panel.getByText(
    "Export includes all campaign-day records matching the date, channel, audience, and goal filters. Campaign search only affects the table, not the CSV.",
    { exact: true },
  )).toBeVisible();
}

const searchImported: Row[] = [
  ["2026-09-01", "Alpha [VIP]", "Facebook", "Students", "Sales", "10.25", "12345", "1", "20.5"],
  ["2026-09-02", "Alpha [VIP]", "Facebook", "Returning customers", "Awareness", "20.5", "40", "2", "41"],
  ["2026-09-03", "Dot.launch", "Instagram", "Adults (25+)", "Leads", "30.75", "60", "3", ""],
  ["2026-09-04", "Star*sale", "Pinterest", "Students", "Sales", "0", "0", "0", "0"],
  ["2026-09-05", "A|B", "Twitter", "Professionals", "Brand ^boost$", "40", "80", "4", "120"],
  ["2026-09-06", "Plain control", "Facebook", "General", "Sales", "50", "100", "5", "100"],
  ["2026-09-07", "Straße launch", "Instagram", "General", "Awareness", "60", "120", "6", "180"],
].map(values => Object.fromEntries(columns.map((column, index) => [column, values[index]])));

test.beforeEach(async ({ page }) => {
  // Each test gets a new browser context and a real, isolated Streamlit session.
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "AdScope", exact: true })).toBeVisible();
  await expect(page.getByText("Current dataset: sample", { exact: true })).toBeVisible();
  await recordCount(page, 720, 720);
});

for (const interval of ["Daily", "Weekly", "Monthly"] as const) {
  test(`native time-series controls render golden ${interval.toLowerCase()} totals for every metric`, async ({ page }) => {
    await upload(page, fixture);
    await confirm(page, "aliased_campaigns.csv", 6);
    await expect(page.getByTestId("stAlert").filter({ hasText: "missing revenue" })).toBeVisible();
    await selectSeries(page, "Group by", interval);
    const { dates, buckets } = seriesGolden[interval];
    for (const [index, metric] of seriesMetrics.entries()) {
      await selectSeries(page, "Metric", metric);
      await assertSeries(page, interval, metric, dates, buckets.map(bucket => bucket[index]));
    }
  });
}

test("shared filters recompute monthly revenue without resetting visible time-series choices", async ({ page }) => {
  await upload(page, fixture);
  await confirm(page, "aliased_campaigns.csv", 6);
  await selectSeries(page, "Group by", "Monthly");
  await selectSeries(page, "Metric", "Revenue · USD");
  const allDates = seriesGolden.Monthly.dates;
  await assertSeries(page, "Monthly", "Revenue · USD", allDates, [30, 130, null]);
  for (const { label, option, count, dates, values, missing } of [
    { label: "Channel", option: "Facebook", count: 3, dates: allDates, values: [30, 90, 300], missing: false },
    { label: "Audience", option: "Students", count: 2, dates: allDates.slice(1), values: [40, null], missing: true },
    { label: "Campaign goal", option: "Sales", count: 4, dates: allDates, values: [30, 90, 300], missing: false },
  ]) {
    await choose(page, label, option);
    await recordCount(page, count, 6);
    await assertSeries(page, "Monthly", "Revenue · USD", dates, values);
    await expect(page.getByTestId("stAlert").filter({ hasText: "missing revenue" })).toHaveCount(missing ? 1 : 0);
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await recordCount(page, 6, 6);
    await assertSeries(page, "Monthly", "Revenue · USD", allDates, [30, 130, null]);
  }
  await dateBoundary(page, "start", 9, 1);
  await dateBoundary(page, "end", 10, 1);
  await recordCount(page, 4, 6);
  await assertSeries(page, "Monthly", "Revenue · USD", allDates.slice(1), [130, null]);
  await choose(page, "Audience", "Adults");
  await recordCount(page, 2, 6);
  await assertSeries(page, "Monthly", "Revenue · USD", ["2026-09-01"], [90]);
  await choose(page, "Campaign goal", "Sales");
  await choose(page, "Channel", "Facebook");
  await recordCount(page, 1, 6);
  await assertSeries(page, "Monthly", "Revenue · USD", ["2026-09-01"], [90]);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await recordCount(page, 6, 6);
  await assertSeries(page, "Monthly", "Revenue · USD", allDates, [30, 130, null]);
});

for (const { interval, metric, filteredValues } of [
  { interval: "Monthly", metric: "Revenue · USD", filteredValues: [30, 90, 300] },
  { interval: "Weekly", metric: "ROI · %", filteredValues: [20, null, null, null, null, 200] },
] as const) {
  test(`empty shared-filter intersection removes ${interval.toLowerCase()} ${metric} and recovers default chart controls`, async ({ page }) => {
    await upload(page, fixture);
    await confirm(page, "aliased_campaigns.csv", 6);
    await selectSeries(page, "Group by", interval);
    await selectSeries(page, "Metric", metric);
    const golden = seriesGolden[interval];
    await assertSeries(page, interval, metric, golden.dates,
      golden.buckets.map(bucket => bucket[metric === "Revenue · USD" ? 3 : 4]));

    // Both selections have records on their own, but Facebook has no Students.
    // Prove a populated filtered chart before making the intersection empty.
    await choose(page, "Channel", "Facebook");
    await recordCount(page, 3, 6);
    await assertSeries(page, interval, metric, golden.dates, [...filteredValues]);
    await choose(page, "Audience", "Students");
    await recordCount(page, 0, 6);
    const panel = await openView(page, "Time Series");
    const empty = panel.getByText(
      "No campaigns match these filters. Widen the date range or clear one or more filters.",
      { exact: true },
    );
    await expect(empty).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Performance over time", exact: true })).toBeVisible();
    // app.py renders neither controls nor a figure in the filtered.empty branch.
    // Require removal, not merely invisibility, to catch stale Plotly data.
    await expect(panel.getByTestId("stPlotlyChart")).toHaveCount(0);
    await expect(panel.locator(".js-plotly-plot")).toHaveCount(0);
    await expect(panel.getByTestId("stSelectbox")).toHaveCount(0);
    await expect(panel.getByRole("combobox")).toHaveCount(0);

    const sidebar = page.getByTestId("stSidebar");
    for (const [label, selection] of [["Channel", "Facebook"], ["Audience", "Students"]]) {
      const widget = sidebar.getByTestId("stMultiSelect").filter({
        has: page.getByText(label, { exact: true }),
      });
      await expect(widget.getByRole("combobox")).toBeEnabled();
      await expect(widget.getByTestId("stMultiSelectTagsContainer")).toHaveText(selection);
    }
    const clear = sidebar.getByRole("button", { name: "Clear filters", exact: true });
    await expect(clear).toBeEnabled();
    await clear.click();
    await recordCount(page, 6, 6);
    await expect(sidebar.getByTestId("stMultiSelectTagsContainer")).toHaveCount(3);
    for (const tags of await sidebar.getByTestId("stMultiSelectTagsContainer").all()) {
      await expect(tags).toHaveText("");
    }

    // The unkeyed selectboxes are absent for an entire empty-state rerun, so
    // Streamlit cleans up their widget state. Clear filters restores defaults,
    // unlike a nonempty filter change, which preserves the selected choices.
    await assertSeries(page, "Daily", "Spend · USD", seriesGolden.Daily.dates,
      seriesGolden.Daily.buckets.map(bucket => bucket[0]));
    await expect(empty).toHaveCount(0);

    // Recovery must leave the visible controls usable, not just redraw a chart.
    await selectSeries(page, "Group by", interval);
    await selectSeries(page, "Metric", metric);
    await assertSeries(page, interval, metric, golden.dates,
      golden.buckets.map(bucket => bucket[metric === "Revenue · USD" ? 3 : 4]));
  });
}

test("weekly ROI remains selected as filters remove missing revenue or select zero spend", async ({ page }) => {
  await upload(page, fixture);
  await confirm(page, "aliased_campaigns.csv", 6);
  await selectSeries(page, "Group by", "Weekly");
  await selectSeries(page, "Metric", "ROI · %");
  const { dates, buckets } = seriesGolden.Weekly;
  for (const { channel, count, wantedDates, values, missing } of [
    { channel: "Facebook", count: 3, wantedDates: dates, values: [20, null, null, null, null, 200], missing: false },
    { channel: "Twitter", count: 1, wantedDates: ["2026-09-28"], values: [null], missing: true },
    { channel: "Pinterest", count: 1, wantedDates: ["2026-09-07"], values: [null], missing: false },
  ]) {
    await choose(page, "Channel", channel);
    await recordCount(page, count, 6);
    await assertSeries(page, "Weekly", "ROI · %", wantedDates, values);
    await expect(page.getByTestId("stAlert").filter({ hasText: "missing revenue" })).toHaveCount(missing ? 1 : 0);
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await recordCount(page, 6, 6);
    await assertSeries(page, "Weekly", "ROI · %", dates, buckets.map(bucket => bucket[4]));
  }
});

test("native upload without a revenue column leaves revenue and ROI gaps but preserves count and spend series", async ({ page }) => {
  const source = await readFile(fixture, "utf8");
  // Use the documented calculation fixture, omitting its optional revenue field.
  const rows: string[][] = parse(source, { skip_empty_lines: true });
  await upload(page, {
    name: "no-revenue.csv", mimeType: "text/csv",
    buffer: Buffer.from(rows.map(row => row.slice(0, -1).join(",")).join("\n")),
  });
  await confirm(page, "no-revenue.csv", 6);
  await expect(page.getByTestId("stAlert").filter({ hasText: "missing revenue" })).toBeVisible();
  await selectSeries(page, "Group by", "Monthly");
  const { dates, buckets } = seriesGolden.Monthly;
  for (const [index, metric] of seriesMetrics.entries()) {
    await selectSeries(page, "Metric", metric);
    await assertSeries(page, "Monthly", metric, dates,
      index >= 3 ? [null, null, null] : buckets.map(bucket => bucket[index]));
  }
});

test("reordered matching headers prefill saved choices but allow edits before a later import", async ({ page }) => {
  const headers = ["When", "Name", "Network", "Segment", "Purpose", "Budget", "Visits", "Results", "Money", "Other date"];
  const sources = headers.slice(0, columns.length);
  const sidebar = page.getByTestId("stSidebar");
  const notice = sidebar.getByText(
    "Column choices from your last successful import are prefilled for " +
    "these matching headers. Review or edit them, then select Import mapped CSV. " +
    "Your current data stays unchanged until you confirm a valid import.",
    { exact: true },
  );
  const format = sidebar.getByRole("combobox", { name: "Date format", exact: true });
  const dateMapping = sidebar.getByRole("combobox", { name: "Date (required)", exact: true });

  async function select(label: string, option: string) {
    const control = sidebar.getByRole("combobox", { name: label, exact: true });
    await expect(control).toHaveCount(1);
    await control.click();
    await control.fill(option);
    await control.press("ArrowDown");
    await page.getByRole("option", { name: option, exact: true }).click();
    await expect(control).toHaveValue(option);
  }

  async function choices(expectedSources: string[]) {
    for (const [index, field] of columns.entries()) {
      const label = `${field[0].toUpperCase()}${field.slice(1)} ` +
        (field === "revenue" ? "(optional)" : "(required)");
      const control = sidebar.getByRole("combobox", { name: label, exact: true });
      await expect(control).toHaveCount(1);
      await expect(control).toBeVisible();
      await expect(control).toHaveValue(expectedSources[index]);
    }
  }

  async function review(source: string, rows: string[][]) {
    await expect(dateMapping).toHaveValue(source);
    await expect(format).toHaveValue("YYYY-MM-DD");
    await expect(sidebar.getByText(
      "Using YYYY-MM-DD · review dates from the selected column in pages of 10. " +
      "Check the month/day order before importing. This preview does not change " +
      "your current dataset or filters; every row is validated on confirmation.",
      { exact: true },
    )).toBeVisible();
    const tables = sidebar.getByTestId("stDataFrame");
    await expect(tables).toHaveCount(2);
    await expect(tables.nth(1)).toBeVisible();
    await expect.poll(async () => gridContents(page, tables.nth(1))).toEqual({
      count: "3",
      headers: ["CSV row", "Original date", "Interpreted date (YYYY-MM-DD)"],
      rows,
    });
    await expect(sidebar.getByRole("button", { name: "Import mapped CSV", exact: true })).toBeEnabled();
  }

  await upload(page, {
    name: "custom-first.csv", mimeType: "text/csv",
    buffer: Buffer.from(`${headers.join(",")}\n` +
      "03/04/2026,First campaign,Facebook,Adults,Sales,10,20,2,30,07/08/2026\n"),
  });
  await expect(notice).toHaveCount(0);
  await expect(format).toHaveValue("YYYY-MM-DD");
  for (const [index, field] of columns.entries()) {
    const label = `${field[0].toUpperCase()}${field.slice(1)} ` +
      (field === "revenue" ? "(optional)" : "(required)");
    await select(label, sources[index]);
  }
  await select("Date format", "MM/DD/YYYY");
  await choices(sources);
  await expect(format).toHaveValue("MM/DD/YYYY");
  await confirm(page, "custom-first.csv", 1);
  expect(await exported(page)).toEqual([
    { date: "2026-03-04", campaign: "First campaign", channel: "Facebook", audience: "Adults",
      goal: "Sales", spend: "10", clicks: "20", conversions: "2", revenue: "30" },
  ]);

  // Same complete header set, reversed order and new values. Custom source
  // names cannot be recovered by alias suggestions or positional mapping.
  const laterRows = [
    ["2026-09-01", "Second A", "Instagram", "Students", "Leads", "15", "30", "3", "45", "2026-08-07"],
    ["2026-09-02", "Second B", "Facebook", "Adults", "Sales", "25", "50", "5", "75", "2026-10-09"],
  ];
  await upload(page, {
    name: "custom-reordered.csv", mimeType: "text/csv",
    buffer: Buffer.from([
      [...headers].reverse().join(","),
      ...laterRows.map(row => [...row].reverse().join(",")),
    ].join("\n")),
  });
  await expect(notice).toBeVisible();
  await choices(sources);
  // The previous file's month-first format must not carry into this file.
  await review("When", [
    ["2", "2026-09-01", "2026-09-01"], ["3", "2026-09-02", "2026-09-02"],
  ]);
  await select("Date (required)", "Other date");
  await choices(["Other date", ...sources.slice(1)]);
  await review("Other date", [
    ["2", "2026-08-07", "2026-08-07"], ["3", "2026-10-09", "2026-10-09"],
  ]);
  await confirm(page, "custom-reordered.csv", 2);
  // Every downloaded field is hand-authored; the date must be the edited
  // source, while the other fields retain their saved source-name choices.
  expect(await exported(page)).toEqual([
    { date: "2026-08-07", campaign: "Second A", channel: "Instagram", audience: "Students",
      goal: "Leads", spend: "15", clicks: "30", conversions: "3", revenue: "45" },
    { date: "2026-10-09", campaign: "Second B", channel: "Facebook", audience: "Adults",
      goal: "Sales", spend: "25", clicks: "50", conversions: "5", revenue: "75" },
  ]);
});

test("ambiguous date previews rerender for format and column edits before importing the latest review", async ({ page }) => {
  await upload(page, fileURLToPath(new URL("../fixtures/ambiguous_dates.csv", import.meta.url)));
  const sidebar = page.getByTestId("stSidebar");
  const format = sidebar.getByRole("combobox", { name: "Date format", exact: true });
  const mapping = sidebar.getByRole("combobox", { name: "Date (required)", exact: true });

  async function select(control: Locator, option: string) {
    await expect(control).toHaveCount(1);
    await control.click();
    // Search the native dropdown so later/virtualized source columns are reachable.
    await control.fill(option);
    await control.press("ArrowDown");
    await page.getByRole("option", { name: option, exact: true }).click();
  }

  async function reviewed(dateFormat: string, source: string, rows: string[][]) {
    await expect(format).toHaveValue(dateFormat);
    await expect(mapping).toHaveValue(source);
    await expect(sidebar.getByText(
      `Using ${dateFormat} · review dates from the selected column in pages of 10. ` +
      "Check the month/day order before importing. This preview does not change " +
      "your current dataset or filters; every row is validated on confirmation.",
      { exact: true },
    )).toBeVisible();
    const tables = sidebar.getByTestId("stDataFrame");
    // The first table is the raw CSV; the second is the visible date comparison.
    await expect(tables).toHaveCount(2);
    await expect(tables.nth(1)).toBeVisible();
    await expect.poll(async () => gridContents(page, tables.nth(1))).toEqual({
      count: "3",
      headers: ["CSV row", "Original date", "Interpreted date (YYYY-MM-DD)"],
      rows,
    });
    await expect(page.getByText("Current dataset: sample", { exact: true })).toBeVisible();
    await recordCount(page, 720, 720);
    await expect(sidebar.getByRole("button", { name: "Import mapped CSV", exact: true })).toBeEnabled();
  }

  // Each assertion reads the browser-rendered comparison, not Python state.
  await select(format, "MM/DD/YYYY");
  await reviewed("MM/DD/YYYY", "date", [
    ["2", "03/04/2026", "2026-03-04"],
    ["3", "05/06/2026", "2026-05-06"],
  ]);
  await select(format, "DD/MM/YYYY");
  await reviewed("DD/MM/YYYY", "date", [
    ["2", "03/04/2026", "2026-04-03"],
    ["3", "05/06/2026", "2026-06-05"],
  ]);
  await select(mapping, "Other date");
  await reviewed("DD/MM/YYYY", "Other date", [
    ["2", "07/08/2026", "2026-08-07"],
    ["3", "09/10/2026", "2026-10-09"],
  ]);

  await confirm(page, "ambiguous_dates.csv", 2);
  // Full native-download contents prove confirmation used both latest choices,
  // rather than the initial mapping or the previously reviewed month-first dates.
  expect(await exported(page)).toEqual([
    { date: "2026-08-07", campaign: "Ambiguous A", channel: "Facebook", audience: "Adults",
      goal: "Sales", spend: "10", clicks: "20", conversions: "2", revenue: "30" },
    { date: "2026-10-09", campaign: "Ambiguous B", channel: "Instagram", audience: "Students",
      goal: "Leads", spend: "15", clicks: "30", conversions: "3", revenue: "45" },
  ]);
});

test("later date-preview pages refresh native format and mapping edits and confirmation validates off-page rows", async ({ page }) => {
  test.setTimeout(90_000);
  // Three pages, with an impossible date only in the alternate column on the
  // last page. All first-page dates are valid in either slash-separated format.
  const dates = [
    "01/04/2026", "02/04/2026", "03/04/2026", "04/04/2026", "05/04/2026", "06/04/2026",
    "07/04/2026", "08/04/2026", "09/04/2026", "10/04/2026", "11/04/2026", "12/04/2026",
    "01/04/2026", "02/04/2026", "03/04/2026", "04/04/2026", "05/04/2026", "06/04/2026",
    "07/04/2026", "08/04/2026", "09/04/2026", "10/04/2026",
  ];
  const isoDates = [
    "2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06",
    "2026-04-07", "2026-04-08", "2026-04-09", "2026-04-10", "2026-04-11", "2026-04-12",
    "2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06",
    "2026-04-07", "2026-04-08", "2026-04-09", "2026-04-10",
  ];
  await upload(page, {
    name: "paged-dates.csv", mimeType: "text/csv",
    buffer: Buffer.from(`${columns.join(",")},Other date\n` + dates.map((date, index) =>
      `${date},Paged ${index + 1},Facebook,Adults,Sales,10,20,2,30,` +
      (index === 20 ? "31/02/2026" : date.replace("/04/", "/08/")),
    ).join("\n")),
  });
  const sidebar = page.getByTestId("stSidebar");
  const previewPage = sidebar.getByRole("spinbutton", { name: "Date preview page", exact: true });
  const format = sidebar.getByRole("combobox", { name: "Date format", exact: true });
  const mapping = sidebar.getByRole("combobox", { name: "Date (required)", exact: true });
  await expect(previewPage).toBeEnabled();
  await expect(previewPage).toHaveAttribute("min", "1");
  await expect(previewPage).toHaveAttribute("max", "3");

  async function select(control: Locator, option: string) {
    await expect(control).toHaveCount(1);
    await control.click();
    await control.fill(option);
    await control.press("ArrowDown");
    await page.getByRole("option", { name: option, exact: true }).click();
  }

  async function goToPage(number: number) {
    await previewPage.fill(String(number));
    await previewPage.press("Enter");
    await expect(previewPage).toHaveValue(String(number));
  }

  async function reviewed(
    number: number, dateFormat: string, source: string, rows: string[][], totalRows: number,
  ) {
    await expect(previewPage).toHaveValue(String(number));
    await expect(format).toHaveValue(dateFormat);
    await expect(mapping).toHaveValue(source);
    const ranges = ["2–11", "12–21", "22–23"];
    await expect(sidebar.getByText(
      `Page ${number} of 3 · CSV rows ${ranges[number - 1]} · 22 dates total.`, { exact: true },
    )).toBeVisible();
    const tables = sidebar.getByTestId("stDataFrame");
    await expect(tables).toHaveCount(2);
    await expect(tables.nth(1)).toBeVisible();
    await expect.poll(async () => {
      const grid = await gridContents(page, tables.nth(1));
      // Full pages are virtualized: compare the visible leading rows and total
      // count. The final two-row page can be checked in its entirety.
      return { ...grid, rows: grid.rows.slice(0, rows.length) };
    }).toEqual({
      count: String(totalRows + 1),
      headers: ["CSV row", "Original date", "Interpreted date (YYYY-MM-DD)"],
      rows,
    });
    await expect(page.getByText("Current dataset: sample", { exact: true })).toBeVisible();
    await recordCount(page, 720, 720);
    await expect(sidebar.getByRole("button", { name: "Import mapped CSV", exact: true })).toBeEnabled();
  }

  await select(format, "MM/DD/YYYY");
  await goToPage(2);
  await reviewed(2, "MM/DD/YYYY", "date", [
    ["12", "11/04/2026", "2026-11-04"],
    ["13", "12/04/2026", "2026-12-04"],
    ["14", "01/04/2026", "2026-01-04"],
  ], 10);
  await goToPage(3);
  await reviewed(3, "MM/DD/YYYY", "date", [
    ["22", "09/04/2026", "2026-09-04"], ["23", "10/04/2026", "2026-10-04"],
  ], 2);
  // Both edits must refresh the comparison without silently returning to page 1.
  await select(format, "DD/MM/YYYY");
  await reviewed(3, "DD/MM/YYYY", "date", [
    ["22", "09/04/2026", "2026-04-09"], ["23", "10/04/2026", "2026-04-10"],
  ], 2);
  await select(mapping, "Other date");
  await reviewed(3, "DD/MM/YYYY", "Other date", [
    ["22", "31/02/2026", "Invalid date"], ["23", "10/08/2026", "2026-08-10"],
  ], 2);

  // Confirm from a wholly valid page: validation must still find CSV row 22.
  await goToPage(1);
  await reviewed(1, "DD/MM/YYYY", "Other date", [
    ["2", "01/08/2026", "2026-08-01"],
    ["3", "02/08/2026", "2026-08-02"],
    ["4", "03/08/2026", "2026-08-03"],
  ], 10);
  await sidebar.getByRole("button", { name: "Import mapped CSV", exact: true }).click();
  await expect(sidebar.getByText(
    "Row 22: date must be a valid DD/MM/YYYY date. " +
    "Every row must use the selected format; month/day order is never guessed.", { exact: true },
  )).toBeVisible();
  await expect(sidebar.getByText(
    "Import failed. Your current dataset and filters are unchanged.", { exact: true },
  )).toBeVisible();
  await expect(page.getByText("Current dataset: sample", { exact: true })).toBeVisible();
  await recordCount(page, 720, 720);

  // Retry on the last page using the valid column; download proves all 22 rows,
  // not just the displayed two, were committed with the latest choices.
  await goToPage(3);
  await select(mapping, "date");
  await reviewed(3, "DD/MM/YYYY", "date", [
    ["22", "09/04/2026", "2026-04-09"], ["23", "10/04/2026", "2026-04-10"],
  ], 2);
  await confirm(page, "paged-dates.csv", 22);
  expect(await exported(page)).toEqual(isoDates.map((date, index) => ({
    date, campaign: `Paged ${index + 1}`, channel: "Facebook", audience: "Adults",
    goal: "Sales", spend: "10", clicks: "20", conversions: "2", revenue: "30",
  })));
});

test("native literal searches change only campaign details, never other views or downloaded rows", async ({ page }) => {
  test.setTimeout(180_000);
  await upload(page, fileURLToPath(new URL("../fixtures/search_campaigns.csv", import.meta.url)));
  await confirm(page, "search_campaigns.csv", 7);
  const before = await otherViews(page);
  const all: [string, string, number][] = [
    ["Instagram", "Straße launch", 60], ["Facebook", "Plain control", 50],
    ["Twitter", "A|B", 40], ["Facebook", "Alpha [VIP]", 30.75],
    ["Instagram", "Dot.launch", 30.75], ["Pinterest", "Star*sale", 0],
  ];
  const cases: { query: string; rows: [string, string, number][] }[] = [
    { query: "aLpHa", rows: [all[3]] },
    { query: "  fAcEbOoK  ", rows: [all[1], all[3]] },
    { query: "sTuDeNtS", rows: [["Facebook", "Alpha [VIP]", 10.25], all[5]] },
    { query: "aWaReNeSs", rows: [all[0], ["Facebook", "Alpha [VIP]", 20.5]] },
    { query: "[VIP]", rows: [all[3]] },
    { query: ".", rows: [all[4]] },
    { query: "*", rows: [all[5]] },
    { query: "A|B", rows: [all[2]] },
    { query: "(25+)", rows: [all[4]] },
    { query: "^boost$", rows: [all[2]] },
    { query: "STRASSE", rows: [all[0]] },
    ...["not present", "12345", "2026-09-01", ".*", "\\", "[missing"].map(
      query => ({ query, rows: [] })),
    { query: "   ", rows: all },
    { query: "", rows: all },
  ];
  for (const { query, rows } of cases) {
    await test.step(`Search ${JSON.stringify(query)}`, async () => {
      await searchFor(page, query, rows);
      await recordCount(page, 7, 7);
      expect(await exported(page)).toEqual(searchImported);
      expect(await otherViews(page)).toEqual(before);
    });
  }
});

test("native downloads escape formula metadata and use shared filters rather than campaign search", async ({ page }) => {
  test.setTimeout(120_000);
  const cases: { input: string | null; expected: string }[] = JSON.parse(await readFile(
    new URL("../fixtures/export_metadata.json", import.meta.url), "utf8"));
  // Blank/null metadata cannot be imported; channel must remain a supported
  // platform. Import trims outer whitespace before the export safety step.
  const valid = cases.filter((item): item is { input: string; expected: string } =>
    item.input !== null && item.input.trim() !== "");
  const safeRows: Row[] = valid.map((item, index) => {
    const normalizedExpected = item.expected.startsWith("'") && !item.input.trim().startsWith("'")
      ? "'" + item.expected.slice(1).trim() : item.expected.trim();
    return {
      date: `2026-09-${String(index + 8).padStart(2, "0")}`,
      campaign: normalizedExpected, channel: "Facebook",
      audience: normalizedExpected, goal: normalizedExpected,
      spend: "12.5", clicks: "1234567", conversions: "0", revenue: "",
    };
  });
  const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const metadataCsv = valid.map((item, index) => [
    safeRows[index].date, item.input, "Facebook", item.input, item.input,
    "12.5", "1234567", "0", "",
  ].map(csvCell).join(",")).join("\n");
  const source = await readFile(new URL("../fixtures/search_campaigns.csv", import.meta.url), "utf8");
  await upload(page, {
    name: "search-and-safe-metadata.csv", mimeType: "text/csv",
    buffer: Buffer.from(source.trimEnd() + "\n" + metadataCsv + "\n"),
  });
  const full = [...searchImported, ...safeRows];
  await confirm(page, "search-and-safe-metadata.csv", full.length);
  expect(await exported(page)).toEqual(full);
  const before = await otherViews(page);
  await searchFor(page, "=sUm(1,2)", [["Facebook", "=SUM(1,2)", 25]]);
  // Escaping is export-only: the UI groups two normalized unescaped campaigns.
  expect(await exported(page)).toEqual(full);
  expect(await otherViews(page)).toEqual(before);
  await searchFor(page, "@sUm(a1:a2)", [["Facebook", "@SUM(A1:A2)", 25]]);
  expect(await exported(page)).toEqual(full);
  expect(await otherViews(page)).toEqual(before);

  await choose(page, "Channel", "Facebook");
  await choose(page, "Channel", "Pinterest");
  await choose(page, "Audience", "Students");
  await choose(page, "Campaign goal", "Sales");
  await dateBoundary(page, "end", 9, 4);
  await recordCount(page, 2, full.length);
  const filtered = [searchImported[0], searchImported[3]];
  const filteredViews = await otherViews(page);
  await searchFor(page, "[vIp]", [["Facebook", "Alpha [VIP]", 10.25]]);
  expect(await exported(page)).toEqual(filtered);
  expect(await otherViews(page)).toEqual(filteredViews);
  // A search can't restore Dot.launch, excluded by the shared intersection.
  await searchFor(page, ".", []);
  expect(await exported(page)).toEqual(filtered);
  expect(await otherViews(page)).toEqual(filteredViews);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await recordCount(page, full.length, full.length);
  await searchFor(page, "not present", []);
  expect(await exported(page)).toEqual(full);
});

test("unsafe dataframe exports are unavailable while tables and safe CSV exports retain metadata", async ({ page }) => {
  test.setTimeout(120_000);
  // Audit before mitigation: six actual toolbar CSV downloads (two batches in
  // all three views) were parsed via csv-parse. Overview exported Campaign
  // formulas unchanged; Details also exported them in audiences/goals.
  // Platform Comparison contained only valid channels and numeric aggregates.
  // Regression contract: built-in exports stay disabled, raw table values stay
  // unchanged, and the dedicated native CSV download escapes every case.
  const cases: { input: string | null; expected: string }[] = JSON.parse(await readFile(
    new URL("../fixtures/export_metadata.json", import.meta.url), "utf8"));
  const valid = cases.filter((item): item is { input: string; expected: string } =>
    item.input !== null && item.input.trim() !== "");
  const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  // Four rows per import keeps every case within Overview's top-eight limit
  // and Glide's visible-row accessibility window.
  // A supported channel is intentional: formula channels are rejected by import.
  for (let offset = 0; offset < valid.length; offset += 4) {
    const batch = valid.slice(offset, offset + 4);
    const body = batch.map((item, index) => [
      `2026-09-${String(index + 1).padStart(2, "0")}`,
      item.input, "Facebook", item.input, item.input, "12.5", "10", "1", "30",
    ].map(csvCell).join(",")).join("\n");
    await upload(page, {
      name: "toolbar-metadata.csv", mimeType: "text/csv",
      buffer: Buffer.from(columns.join(",") + "\n" + body + "\n"),
    });
    await confirm(page, "toolbar-metadata.csv", batch.length);
    const normalized = batch.map(item => item.input.trim());
    const campaigns = [...new Set(normalized)];
    for (const name of ["Overview", "Platform Comparison", "Campaign Details"]) {
      await test.step(`${name}, metadata cases ${offset + 1}–${offset + batch.length}`, async () => {
        const panel = await openView(page, name);
        const table = panel.getByTestId("stDataFrame");
        await expect(table).toHaveCount(1);
        await table.hover();
        await expect(table.getByRole("button", {
          name: "Download as CSV", exact: true,
        })).toHaveCount(0);
        // Import confirmation can arrive before the canvas finishes updating.
        // Wait for the expected native grid, not the previous sample's rows.
        await expect.poll(async () => (await gridContents(page, panel)).count)
          .toBe(String((name === "Platform Comparison" ? 1 : campaigns.length) + 1));
        const grid = await gridContents(page, panel);
        for (const row of grid.rows) {
          const campaignIndex = grid.headers.indexOf("Campaign");
          const groupSize = campaignIndex < 0 ? batch.length :
            normalized.filter(value => value === row[campaignIndex]).length;
          expect(displayedSpend(row[grid.headers.indexOf("Spend · USD")])).toBe(12.5 * groupSize);
        }
        const metadata = name === "Platform Comparison" ? ["Channel"] : ["Channel", "Campaign"];
        for (const field of metadata) {
          const index = grid.headers.indexOf(field);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(grid.rows.map(row => row[index]).sort()).toEqual(
            (field === "Channel" ? Array(name === "Platform Comparison" ? 1 : campaigns.length).fill("Facebook")
              : campaigns).sort());
        }
      });
    }
    const rows = await exported(page);
    expect(rows).toEqual(batch.map((item, index) => {
      const value = item.expected.startsWith("'") && !item.input.trim().startsWith("'")
        ? "'" + item.expected.slice(1).trim() : item.expected.trim();
      return {
        date: `2026-09-${String(index + 1).padStart(2, "0")}`,
        campaign: value, channel: "Facebook", audience: value, goal: value,
        spend: "12.5", clicks: "10", conversions: "1", revenue: "30",
      };
    }));
    for (const row of rows) {
      for (const field of ["campaign", "channel", "audience", "goal"]) {
        expect(row[field].trimStart()).not.toMatch(/^[=+\-@]/);
      }
    }
  }
});

for (const view of ["Overview", "Platform Comparison"]) {
  test(`Plotly controls cannot expose spreadsheet exports in ${view}, including fullscreen`, async ({ page }) => {
    test.setTimeout(120_000);
    const cases: { input: string | null; expected: string }[] = JSON.parse(await readFile(
      new URL("../fixtures/export_metadata.json", import.meta.url), "utf8"));
    const valid = cases.filter((item): item is { input: string; expected: string } =>
      item.input !== null && item.input.trim() !== "");
    const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const dates = valid.map((_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
    const body = valid.map((item, index) => [
      dates[index], item.input, "Facebook", item.input, item.input, "12.5", "10", "1", "30",
    ].map(csvCell).join(",")).join("\n");
    // Channels must be valid imports. Formula-like campaign/audience/goal
    // values exercise the export boundary without creating rejected fixtures.
    await upload(page, {
      name: "chart-metadata.csv", mimeType: "text/csv",
      buffer: Buffer.from(columns.join(",") + "\n" + body + "\n"),
    });
    await confirm(page, "chart-metadata.csv", valid.length);
    const panel = await openView(page, view);
    const chart = panel.getByTestId("stPlotlyChart");
    const plot = chart.locator(".js-plotly-plot");
    const expectedTraces = view === "Overview" ? [
      { type: "bar", x: dates, y: dates.map(() => 12.5) },
      { type: "scatter", x: dates, y: dates.map(() => 1) },
    ] : [
      { type: "bar", x: ["Facebook"], y: [valid.length * 12.5] },
      { type: "bar", x: ["Facebook"], y: [valid.length] },
    ];
    async function presentation() {
      await expect(plot).toBeVisible();
      // Wait for rendered, decoded values, not the previous sample's traces.
      await expect.poll(() => plot.evaluate(element => {
        const figure = element as HTMLElement & {
          _fullData: { type: string; x: string[]; y: ArrayLike<number> }[];
        };
        return figure._fullData.map(trace => ({
          type: trace.type,
          x: Array.from(trace.x, value => value.slice(0, 10)),
          y: Array.from(trace.y),
        }));
      })).toEqual(expectedTraces);
      if (view === "Overview") {
        await expect(plot.locator(".gtitle")).toHaveText("Spend against conversions");
      } else {
        await expect(plot.locator(".annotation-text")).toHaveText(["Spend · USD", "Conversions · count"]);
      }
    }
    async function controls(fullscreen: boolean) {
      // Audit: these app.py Plotly charts have no Show data/table menus in
      // Streamlit 1.65. Hover exposes the native modebar; an explicit allowlist
      // fails if an upgrade adds a menu or CSV/copy affordance. Do not silently
      // skip an absent menu: future table controls require a native-open audit.
      await chart.hover();
      await expect(chart.getByRole("button")).toHaveCount(8);
      await expect.poll(() => chart.getByRole("button").evaluateAll(
        buttons => buttons.map(button => button.getAttribute("aria-label")),
      )).toEqual([
        "Download plot as a PNG", "Zoom", "Pan", "Zoom in", "Zoom out",
        "Autoscale", "Reset axes", fullscreen ? "Close fullscreen" : "Fullscreen",
      ]);
      await expect(chart.getByRole("menuitem")).toHaveCount(0);
      await expect(chart.getByRole("link")).toHaveCount(0);
      await expect(chart.getByRole("button", { name: /show data|table|csv|copy|clipboard|export/i })).toHaveCount(0);
      await expect(chart.getByTestId("stDataFrame")).toHaveCount(0);
      await expect(chart.getByRole("table")).toHaveCount(0);
      await expect(chart.getByRole("grid")).toHaveCount(0);
    }
    await presentation();
    await controls(false);
    // Exercise real navigation and both native modebar states, not React
    // internals or synthetic handler calls.
    await chart.getByRole("button", { name: "Zoom in", exact: true }).click();
    await chart.getByRole("button", { name: "Reset axes", exact: true }).click();
    await presentation();
    await chart.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await controls(true);
    await presentation();
    await chart.getByRole("button", { name: "Close fullscreen", exact: true }).click();
    await controls(false);
    await presentation();

    // Image export is intentionally allowed and remains a genuine PNG, not a
    // spreadsheet download hidden behind an image-labelled control.
    const imageEvent = page.waitForEvent("download");
    await chart.getByRole("button", { name: "Download plot as a PNG", exact: true }).click();
    const image = await imageEvent;
    expect(image.suggestedFilename()).toMatch(/\.png$/);
    expect(await image.failure()).toBeNull();
    const imagePath = await image.path();
    expect(imagePath).not.toBeNull();
    expect((await readFile(imagePath!)).subarray(0, 8))
      .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    expect(await exported(page)).toEqual(valid.map((item, index) => {
      const value = item.expected.startsWith("'") && !item.input.trim().startsWith("'")
        ? "'" + item.expected.slice(1).trim() : item.expected.trim();
      return {
        date: dates[index], campaign: value, channel: "Facebook", audience: value, goal: value,
        spend: "12.5", clicks: "10", conversions: "1", revenue: "30",
      };
    }));
  });
}

for (const view of ["Overview", "Campaign Details"]) {
  test(`native keyboard copy cannot export metadata from ${view}, but navigation and safe CSV work`, async ({
    page, context,
  }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    // Positive control: prove the real browser clipboard and native shortcut
    // work, rather than passing because Chromium refused clipboard access.
    const sentinel = "AdScope clipboard positive control";
    await page.evaluate(() => {
      const control = document.createElement("textarea");
      control.id = "clipboard-positive-control";
      document.body.append(control);
    });
    const control = page.locator("#clipboard-positive-control");
    await control.fill(sentinel);
    await control.press("ControlOrMeta+a");
    await control.press("ControlOrMeta+c");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(sentinel);
    await control.evaluate(element => element.remove());

    const cases: { input: string | null; expected: string }[] = JSON.parse(await readFile(
      new URL("../fixtures/export_metadata.json", import.meta.url), "utf8"));
    const valid = cases.filter((item): item is { input: string; expected: string } =>
      item.input !== null && item.input.trim() !== "");
    const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
    // Keep every grouped row inside the snapshot limit and accessible window.
    // Formula channels are invalid imports; use a real supported channel.
    for (let offset = 0; offset < valid.length; offset += 4) {
      const batch = valid.slice(offset, offset + 4);
      const body = batch.map((item, index) => [
        `2026-09-${String(index + 1).padStart(2, "0")}`,
        item.input, "Facebook", item.input, item.input, "12.5", "10", "1", "30",
      ].map(csvCell).join(",")).join("\n");
      await upload(page, {
        name: "clipboard-metadata.csv", mimeType: "text/csv",
        buffer: Buffer.from(columns.join(",") + "\n" + body + "\n"),
      });
      await confirm(page, "clipboard-metadata.csv", batch.length);
      const panel = await openView(page, view);
      const table = panel.getByTestId("stDataFrame");
      // Streamlit accepts cell-selection changes only while the pointer is
      // inside the grid (keyboard focus alone is not sufficient).
      await table.hover();
      const canvas = panel.getByTestId("data-grid-canvas").filter({ visible: true });
      const grid = canvas.getByRole("grid", { includeHidden: true });
      const selected = grid.locator('td[aria-selected="true"]');
      await canvas.focus();
      await canvas.press("ArrowDown");
      await expect(selected).toHaveCount(1);
      // A replacement import can retain the previous horizontal scroll.
      // Return to the first column before comparing virtualized campaign cells.
      await page.keyboard.press("ControlOrMeta+Home");
      await expect(selected).toHaveAttribute("id", "glide-cell-0-0");
      const campaigns = [...new Set(batch.map(item => item.input.trim()))].sort();
      await expect.poll(async () => {
        const contents = await gridContents(page, panel);
        const index = contents.headers.indexOf("Campaign");
        return contents.rows.map(row => row[index]).sort();
      }).toEqual(campaigns);
      const metadata = view === "Overview" ? [["Campaign", 1] as const] :
        [["Campaign", 1], ["audiences", 10], ["goals", 11]] as const;
      const rows = await grid.locator("tbody tr").count();

      for (let row = 0; row < rows; row++) {
        await page.keyboard.press("ControlOrMeta+Home");
        await expect(selected).toHaveAttribute("id", "glide-cell-0-0");
        for (let index = 0; index < row; index++) {
          await page.keyboard.press("ArrowDown");
          await expect(selected).toHaveAttribute("id", `glide-cell-0-${index + 1}`);
        }
        for (const [field, column] of metadata) {
          await test.step(`${field}, batch ${offset / 4 + 1}, row ${row + 1}`, async () => {
            // Native navigation, not a hidden fallback-cell click or React state.
            if (field === "audiences") {
              // End moves to the last column without changing the row.
              await page.keyboard.press("End");
              await expect(selected).toHaveAttribute("id", `glide-cell-11-${row}`);
              await page.keyboard.press("ArrowLeft");
            } else {
              await page.keyboard.press("ArrowRight");
            }
            const cellId = `glide-cell-${column}-${row}`;
            await expect(selected).toHaveAttribute("id", cellId);
            // Metadata columns to the right are virtualized until navigation
            // brings them into view. Assert the rendered header, not its array
            // position in the initially visible subset.
            await expect(grid.locator(`th[aria-colindex="${column + 1}"]`)).toHaveText(field);
            const raw = await selected.textContent();
            expect(campaigns).toContain(raw);
            await expect(selected).toHaveAttribute("aria-readonly", "true");
            // Glide moves native focus into its accessible selected cell.
            await expect(selected).toBeFocused();

            const marker = `${sentinel}: ${view}/${offset}/${row}/${field}`;
            await page.evaluate(value => navigator.clipboard.writeText(value), marker);
            await page.keyboard.press("ControlOrMeta+c");
            // A subsequent native move and reconciled selection ensure the copy
            // handler had a chance to run. Reading alone must not race it.
            await page.keyboard.press("ArrowLeft");
            await expect(selected).toHaveAttribute("id", `glide-cell-${column - 1}-${row}`);
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(marker);
            await page.keyboard.press("ArrowRight");
            await expect(selected).toHaveAttribute("id", cellId);
            await expect(selected).toHaveText(raw!);
          });
        }
      }

      const downloaded = await exported(page);
      expect(downloaded).toEqual(batch.map((item, index) => {
        // Import strips outer whitespace; escaping occurs only in the CSV.
        const value = item.expected.startsWith("'") && !item.input.trim().startsWith("'")
          ? "'" + item.expected.slice(1).trim() : item.expected.trim();
        return {
          date: `2026-09-${String(index + 1).padStart(2, "0")}`,
          campaign: value, channel: "Facebook", audience: value, goal: value,
          spend: "12.5", clicks: "10", conversions: "1", revenue: "30",
        };
      }));
      for (const row of downloaded) {
        for (const field of ["campaign", "channel", "audience", "goal"]) {
          expect(row[field].trimStart()).not.toMatch(/^[=+\-@]/);
        }
      }
    }
  });
}

test("sample control downloads a complete, valid CSV with frozen totals", async ({ page }) => {
  const rows = await download(page, "Download sample CSV", "adscope-sample.csv");
  const totals = JSON.parse(await readFile(
    new URL("../fixtures/sample_totals.json", import.meta.url), "utf8"));
  expect(rows).toHaveLength(totals.rows);
  expect(rows[0].date).toBe(totals.start);
  expect(rows.at(-1)!.date).toBe(totals.end);
  expect([...new Set(rows.map(row => row.channel))].sort()).toEqual(
    ["Facebook", "Instagram", "Pinterest", "Twitter"]);
  for (const field of ["spend", "clicks", "conversions", "revenue"]) {
    expect(rows.reduce((sum, row) => sum + Number(row[field]), 0)).toBeCloseTo(totals[field], 2);
  }
});

test("native alias upload stages a preview and only replaces sample data after confirmation", async ({ page }) => {
  await upload(page, fixture);
  await expect(page.getByText("Current dataset: sample", { exact: true })).toBeVisible();
  await recordCount(page, 720, 720);
  expect(await exported(page)).toHaveLength(720);
  await confirm(page, "aliased_campaigns.csv", 6);
  expect(await exported(page)).toEqual(imported);
});

test("concurrent browser sessions keep uploaded rows, filters, and downloads private", async ({
  page, browser, baseURL,
}) => {
  test.setTimeout(120_000);
  // Keep the fixture's context alive while opening a genuinely independent
  // context, not another tab sharing cookies/storage or a sequential session.
  const sampleContext = await browser.newContext({ baseURL, acceptDownloads: true });
  try {
    const samplePage = await sampleContext.newPage();
    expect(samplePage.context()).not.toBe(page.context());
    await samplePage.goto("./");
    await expect(samplePage.getByRole("heading", { name: "AdScope", exact: true })).toBeVisible();
    await recordCount(samplePage, 720, 720);
    const sampleRows = await exported(samplePage);
    expect(sampleRows).toHaveLength(720);
    expect([...new Set(sampleRows.map(row => row.campaign))].sort()).toEqual(
      ["Always-on retargeting", "New customer discovery", "Summer collection"]);
    expect(sampleRows[0].date).toBe("2026-08-01");
    expect(sampleRows.at(-1)!.date).toBe("2026-09-29");

    async function sampleStillActive() {
      await expect(samplePage.getByText("Current dataset: sample", { exact: true })).toBeVisible();
      await expect(samplePage.getByText(
        "Current dataset: aliased_campaigns.csv", { exact: true },
      )).toHaveCount(0);
      await expect(samplePage.getByRole("heading", {
        name: "Preview and map columns", exact: true,
      })).toHaveCount(0);
      await expect(samplePage.getByRole("button", {
        name: "Import mapped CSV", exact: true,
      })).toHaveCount(0);
    }

    async function filters(
      target: Page, selections: string[], start: number[], end: number[],
    ) {
      for (const [index, label] of ["Channel", "Audience", "Campaign goal"].entries()) {
        const widget = target.getByTestId("stMultiSelect").filter({
          has: target.getByRole("combobox", { name: label, exact: true }),
        });
        await expect(widget.getByTestId("stMultiSelectTagsContainer")).toHaveText(selections[index]);
      }
      for (const [boundary, values] of [["start", start], ["end", end]] as const) {
        for (const [index, segment] of ["year", "month", "day"].entries()) {
          await expect(target.getByRole("spinbutton", {
            name: `${segment}, Date range · inclusive ${boundary} date`, exact: true,
          })).toHaveAttribute("aria-valuenow", String(values[index]));
        }
      }
    }

    await upload(page, fixture);
    await sampleStillActive();
    await filters(samplePage, ["", "", ""], [2026, 8, 1], [2026, 9, 29]);
    expect(await exported(samplePage)).toEqual(sampleRows);
    await confirm(page, "aliased_campaigns.csv", 6);
    await sampleStillActive();
    await recordCount(samplePage, 720, 720);
    const initialDownloads = await Promise.all([exported(page), exported(samplePage)]);
    expect(initialDownloads).toEqual([imported, sampleRows]);

    // Different selections and date ranges must survive interleaved reruns
    // in both live sessions, including simultaneous native downloads.
    for (const [label, uploadedSelection, sampleSelection] of [
      ["Channel", "Facebook", "Instagram"],
      ["Audience", "Adults", "Adults 18–34"],
      ["Campaign goal", "Sales", "Lead generation"],
    ]) {
      await Promise.all([
        choose(page, label, uploadedSelection),
        choose(samplePage, label, sampleSelection),
      ]);
    }
    await Promise.all([
      dateBoundary(page, "start", 9, 1),
      dateBoundary(samplePage, "start", 8, 2),
    ]);
    await Promise.all([
      dateBoundary(page, "end", 10, 1),
      dateBoundary(samplePage, "end", 9, 1),
    ]);
    const filteredSample = sampleRows.filter(row =>
      row.channel === "Instagram" && row.audience === "Adults 18–34" &&
      row.goal === "Lead generation" && row.date >= "2026-08-02" && row.date <= "2026-09-01");
    expect(filteredSample).toHaveLength(31);
    await recordCount(page, 1, 6);
    await recordCount(samplePage, 31, 720);
    await filters(page, ["Facebook", "Adults", "Sales"], [2026, 9, 1], [2026, 10, 1]);
    await filters(samplePage, ["Instagram", "Adults 18–34", "Lead generation"],
      [2026, 8, 2], [2026, 9, 1]);
    expect(await Promise.all([exported(page), exported(samplePage)]))
      .toEqual([[imported[1]], filteredSample]);

    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await recordCount(page, 6, 6);
    await recordCount(samplePage, 31, 720);
    await filters(samplePage, ["Instagram", "Adults 18–34", "Lead generation"],
      [2026, 8, 2], [2026, 9, 1]);
    expect(await Promise.all([exported(page), exported(samplePage)]))
      .toEqual([imported, filteredSample]);

    await samplePage.getByRole("button", { name: "Clear filters", exact: true }).click();
    await recordCount(samplePage, 720, 720);
    await sampleStillActive();
    await expect(page.getByText("Current dataset: aliased_campaigns.csv", { exact: true })).toBeVisible();
    await filters(page, ["", "", ""], [2026, 8, 31], [2026, 10, 5]);
    await filters(samplePage, ["", "", ""], [2026, 8, 1], [2026, 9, 29]);
    expect(await Promise.all([exported(page), exported(samplePage)])).toEqual([imported, sampleRows]);
  } finally {
    await sampleContext.close();
  }
});

test("a second native upload preserves active data until confirmed and resets old filters", async ({ page }) => {
  await upload(page, fixture);
  await confirm(page, "aliased_campaigns.csv", 6);
  await choose(page, "Channel", "Facebook");
  await recordCount(page, 3, 6);
  await choose(page, "Audience", "Adults");
  await choose(page, "Campaign goal", "Sales");
  await dateBoundary(page, "start", 9, 1);
  await recordCount(page, 2, 6);
  const prior = [imported[1], imported[5]];
  expect(await exported(page)).toEqual(prior);

  // Different canonical headers keep column-choice reuse outside this test.
  await upload(page, {
    name: "replacement.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`${columns.join(",")}\n` +
      "2026-11-01,Replacement A,Instagram,New audience,Awareness,7,14,1,21\n" +
      "2026-11-02,Replacement B,Twitter,New audience,Leads,8,16,2,24\n"),
  });
  await expect(page.getByText("Current dataset: aliased_campaigns.csv", { exact: true })).toBeVisible();
  await recordCount(page, 2, 6);
  expect(await exported(page)).toEqual(prior);
  await confirm(page, "replacement.csv", 2);
  await expect(page.getByRole("spinbutton", {
    name: "month, Date range · inclusive start date", exact: true,
  })).toHaveAttribute("aria-valuenow", "11");
  for (const boundary of ["start", "end"] as const) {
    await expect(page.getByRole("spinbutton", {
      name: `month, Date range · inclusive ${boundary} date`, exact: true,
    })).toHaveAttribute("aria-valuenow", "11");
    await expect(page.getByRole("spinbutton", {
      name: `day, Date range · inclusive ${boundary} date`, exact: true,
    })).toHaveAttribute("aria-valuenow", boundary === "start" ? "1" : "2");
  }
  for (const control of await page.getByTestId("stMultiSelectTagsContainer").all()) {
    await expect(control).toHaveText("");
  }
  const rows = await exported(page);
  expect(rows).toEqual([
    { date: "2026-11-01", campaign: "Replacement A", channel: "Instagram", audience: "New audience",
      goal: "Awareness", spend: "7", clicks: "14", conversions: "1", revenue: "21" },
    { date: "2026-11-02", campaign: "Replacement B", channel: "Twitter", audience: "New audience",
      goal: "Leads", spend: "8", clicks: "16", conversions: "2", revenue: "24" },
  ]);
});

for (const rejection of [
  {
    name: "malformed rows",
    filename: "malformed.csv",
    contents: `${columns.join(",")}\n2026-11-01,Missing columns\n`,
    error: "Could not read the CSV: Every CSV row must have the same number of columns as the header.",
    confirm: false,
    oversized: false,
  },
  {
    name: "invalid numeric data on confirmation",
    filename: "invalid-spend.csv",
    contents: `${columns.join(",")}\n2026-11-01,Invalid,Instagram,New audience,Awareness,-7,14,1,21\n`,
    error: "Row 2: spend must be a non-negative number.",
    confirm: true,
    oversized: false,
  },
  {
    name: "a file over the upload size limit",
    filename: "oversized.csv",
    // A well-formed CSV one byte above 5 MiB, generated in memory, not committed.
    contents: "",
    error: /File must be .*5.*MB or smaller\./,
    confirm: false,
    oversized: true,
  },
]) {
  test(`rejecting ${rejection.name} preserves data and filters and allows a valid retry`, async ({ page }) => {
    test.setTimeout(90_000);
    await upload(page, fixture);
    await confirm(page, "aliased_campaigns.csv", 6);
    await choose(page, "Channel", "Facebook");
    await recordCount(page, 3, 6);
    await choose(page, "Audience", "Adults");
    await choose(page, "Campaign goal", "Sales");
    await dateBoundary(page, "start", 9, 1);
    await dateBoundary(page, "end", 10, 1);
    await recordCount(page, 1, 6);

    async function preserved() {
      await expect(page.getByText("Current dataset: aliased_campaigns.csv", { exact: true })).toBeVisible();
      await recordCount(page, 1, 6);
      for (const [label, selection] of [
        ["Channel", "Facebook"], ["Audience", "Adults"], ["Campaign goal", "Sales"],
      ]) {
        const widget = page.getByTestId("stMultiSelect").filter({
          has: page.getByRole("combobox", { name: label, exact: true }),
        });
        await expect(widget.getByTestId("stMultiSelectTagsContainer")).toHaveText(selection);
      }
      for (const [boundary, month] of [["start", 9], ["end", 10]] as const) {
        for (const [segment, value] of [["day", 1], ["month", month], ["year", 2026]] as const) {
          await expect(page.getByRole("spinbutton", {
            name: `${segment}, Date range · inclusive ${boundary} date`, exact: true,
          })).toHaveAttribute("aria-valuenow", String(value));
        }
      }
      expect(await exported(page)).toEqual([imported[1]]);
    }

    await preserved();
    const file = {
      name: rejection.filename,
      mimeType: "text/csv",
      buffer: rejection.oversized
        ? Buffer.from("campaign\n" + "A".repeat(5 * 1024 * 1024 + 1 - "campaign\n".length))
        : Buffer.from(rejection.contents),
    };
    if (rejection.oversized) {
      // Streamlit rejects this in the native uploader before any PUT happens.
      // Do not use the transfer helper, which expects a successful transport.
      await page.locator('input[type="file"]').setInputFiles(file);
    } else if (rejection.confirm) {
      await upload(page, file);
      await page.getByRole("button", { name: "Import mapped CSV", exact: true }).click();
    } else {
      await transfer(page, file);
    }
    await expect(page.getByText(rejection.error, { exact: true })).toBeVisible();
    if (!rejection.oversized) {
      await expect(page.getByText(
        "Import failed. Your current dataset and filters are unchanged.", { exact: true },
      )).toBeVisible();
    }
    if (!rejection.confirm) {
      await expect(page.getByRole("button", { name: "Import mapped CSV", exact: true })).toHaveCount(0);
    }
    await preserved();

    // Also verify rows hidden by the active filters survived the rejection.
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await recordCount(page, 6, 6);
    expect(await exported(page)).toEqual(imported);

    // Canonical headers differ from the initial fixture: mapping reuse is not
    // under test. Retry in the same browser session without reload/reset.
    await upload(page, {
      name: "valid-retry.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`${columns.join(",")}\n` +
        "2026-11-01,Valid retry,Instagram,New audience,Awareness,7,14,1,21\n"),
    });
    await expect(page.getByText("Current dataset: aliased_campaigns.csv", { exact: true })).toBeVisible();
    await recordCount(page, 6, 6);
    await confirm(page, "valid-retry.csv", 1);
    expect(await exported(page)).toEqual([
      { date: "2026-11-01", campaign: "Valid retry", channel: "Instagram", audience: "New audience",
        goal: "Awareness", spend: "7", clicks: "14", conversions: "1", revenue: "21" },
    ]);
  });
}

test("downloaded rows follow every shared filter, their intersection, and clear filters", async ({ page }) => {
  await upload(page, fixture);
  await confirm(page, "aliased_campaigns.csv", 6);
  for (const { label, value, indexes } of [
    { label: "Channel", value: "Facebook", indexes: [0, 1, 5] },
    { label: "Audience", value: "Students", indexes: [2, 4] },
    { label: "Campaign goal", value: "Sales", indexes: [0, 1, 3, 5] },
  ]) {
    await choose(page, label, value);
    await recordCount(page, indexes.length, 6);
    expect(await exported(page)).toEqual(indexes.map(index => imported[index]));
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await recordCount(page, 6, 6);
  }

  await dateBoundary(page, "start", 9, 1);
  await dateBoundary(page, "end", 10, 1);
  await recordCount(page, 4, 6);
  expect(await exported(page)).toEqual(imported.slice(1, 5));
  await choose(page, "Audience", "Adults");
  await recordCount(page, 2, 6);
  await choose(page, "Campaign goal", "Sales");
  await recordCount(page, 2, 6);
  await choose(page, "Channel", "Facebook");
  await recordCount(page, 1, 6);
  expect(await exported(page)).toEqual([imported[1]]);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await recordCount(page, 6, 6);
  expect(await exported(page)).toEqual(imported);
  // Sample download stays the full illustrative dataset, even after an import.
  expect(await download(page, "Download sample CSV", "adscope-sample.csv")).toHaveLength(720);
});
