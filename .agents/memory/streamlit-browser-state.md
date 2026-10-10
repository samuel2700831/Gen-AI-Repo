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
