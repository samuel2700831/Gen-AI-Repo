---
name: Streamlit browser state
description: Keyed widget resets and native browser test synchronization in Streamlit.
---

Reset active keyed filters by assigning explicit session-state values, not only deleting their keys.

**Why:** Native browser checks exposed that deleting keys reset the backend defaults while leaving the visible date field on the previous dataset. AppTest did not reveal this frontend mismatch.

**How to apply:** When committing replacement data, verify both exported rows and visible filter controls. For session-state-owned date ranges, initialize state first and avoid supplying a competing widget default.

Wait for Streamlit's rerendered controls to become unique before interacting after a filter change.

**Why:** A record-count caption can update before the old tab tree is removed, briefly exposing two identically named tabs.

**How to apply:** Use retrying locator assertions for reconciliation; do not add fixed sleeps, select an arbitrary duplicate, or retry a whole failing test.

Streamlit's canvas dataframe accessibility content may appear only after native focus and keyboard interaction, and browser locators classify the fallback table as hidden.

**Why:** Browser-visible search regressions need to check actual rendered campaign values; an unfocused canvas gives no accessible rows, even though the table is visibly populated.

**How to apply:** Activate the dataframe with native keyboard interaction and inspect its accessibility fallback, including hidden content. Check row counts as well as cells because fallback rows are virtualized.

Dataframe toolbar exports can use an operating-system save picker instead of emitting a browser download event.

**Why:** Headless Chromium could activate the toolbar but never produced a download event with its native File System Access picker. Removing that browser capability before loading the page allowed Streamlit's real Blob-download fallback to run.

**How to apply:** For future native toolbar audits, select the unsupported-picker browser path before navigation; do not mock CSV generation or download contents. Native keyboard activation avoids toolbar pointer interception by the grid.

Keep fixture batches small when comparing every canvas-accessibility row.

**Why:** Even seven short records exceeded the visible accessibility window at the browser regression viewport. The reported total row count includes records absent from the fallback DOM.

**How to apply:** Use batches small enough for all expected rows to render, or navigate and collect virtualized rows explicitly; never equate the visible fallback with the full dataset.
