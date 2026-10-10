import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { expect, test, type Page } from "@playwright/test";

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
  return records.map(values => Object.fromEntries(columns.map((column, index) => {
    const value = values[index];
    // Compare numeric contents, not pandas' choice of integer/float spelling.
    if (index >= 5 && value !== "") {
      expect(Number.isFinite(Number(value))).toBe(true);
      return [column, String(Number(value))];
    }
    return [column, value];
  })));
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
  await page.getByRole("combobox", { name: label, exact: true }).click();
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

test.beforeEach(async ({ page }) => {
  // Each test gets a new browser context and a real, isolated Streamlit session.
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "AdScope", exact: true })).toBeVisible();
  await expect(page.getByText("Current dataset: sample", { exact: true })).toBeVisible();
  await recordCount(page, 720, 720);
});

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
