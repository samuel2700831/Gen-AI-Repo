---
name: Streamlit launch constraints
description: Managed artifact working directory and first-run Streamlit startup behavior.
---

Managed artifact development workflows start inside the artifact directory. Development script paths must be relative to that directory, while production commands use workspace-root paths.

**Why:** A root-relative development script path failed to start even though the file existed in the workspace.

**How to apply:** Use artifact-relative paths in development launch commands, and keep production path assumptions explicit when changing runtimes.

Launch Streamlit with headless mode enabled.

**Why:** Without headless mode, Streamlit's first-run email prompt waited for input and prevented the managed preview workflow from opening its port.

**How to apply:** Include the headless flag for both development and production launches; treat an onboarding prompt in startup logs as blocked startup rather than a slow app.

A failed managed workflow with a port-in-use error does not necessarily mean the dashboard is unavailable.

**Why:** After workflow reconciliation, older healthy servers continued serving while replacement processes failed on the occupied ports.

**How to apply:** Check endpoint health and process ownership before restarting. Let any active browser checks finish before retiring a stale server, then restart the managed service and verify its preview.
