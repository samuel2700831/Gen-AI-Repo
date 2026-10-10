---
name: CSV mapping decisions
description: Safe alias suggestions and explicit confirmation for marketer uploads.
---

Suggest a column only when exactly one header matches a field's supported aliases. If several match, require the marketer to choose rather than privileging one alias.

**Why:** An export can contain both cost and spend, or multiple conversion measures, with different meanings. Selecting one silently can misrepresent performance.

**How to apply:** Keep alias suggestions provider-neutral. Preview original headers and require explicit import confirmation, even for recognized exports, so reviewing or editing a mapping never replaces the active data or changes filters.

Reuse only the last successful mapping in the current session, and only for the exact set of original headers, including ignored columns. Header order does not matter.

**Why:** Matching normalized aliases or just mapped columns could silently carry choices into a different export schema. Pending edits and failed imports must not become trusted defaults.

**How to apply:** Treat additions, removals, spelling, case, and whitespace changes as incompatible. Keep preview and confirmation even when choices are reused; never persist mappings outside session state.
