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

async function upload(page: Page, file: Parameters<ReturnType<Page["locator"]>["setInputFiles"]>[0]) {
  const transport = page.waitForResponse(response =>
    response.request().method() === "PUT" && response.url().includes("/_stcore/upload_file/"));
  // This uses the native input, not AppTest/session state or an HTTP mock.
  await page.locator('input[type="file"]').setInputFiles(file);
  expect((await transport).ok()).toBe(true);
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
