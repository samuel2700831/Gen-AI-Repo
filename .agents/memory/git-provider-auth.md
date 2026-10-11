---
name: Git provider authentication
description: Native source-control connections and reconnect limitations when exporting project code.
---

Treat native Git-provider connections differently from application API connectors. Follow the returned source-control instructions rather than assuming a directory status requires attachment.

**Why:** The integration directory showed a Git-provider connection as not added, but the attachment callback reported it already active and explained that workspace Git CLIs authenticate automatically.

**How to apply:** Use normal Git commands without extracting credentials. If Git rejects authentication, consult the official Git-provider reconnection instructions. Generic reconnect cards rejected this native connection despite OAuth context reporting healthy; do not repeatedly submit the same card or ask for a token in chat.
