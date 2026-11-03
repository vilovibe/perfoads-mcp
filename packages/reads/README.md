# @perfoads/reads

Typed Google Ads readers: account overview, campaigns, ad groups, keywords, search terms, budgets and bidding, negatives, ads and assets, audiences, conversions, change history. Internal readers for the account snapshot (no tool): bid modifiers, bidding data exclusions and seasonality adjustments, experiments, account content exclusions, landing pages, campaign settings, auto-apply settings, user access counts (roles only, never emails).

- One normaliser (`src/normalise.ts`) turns Google rows into clean values: money in micros becomes a decimal string (BigInt, no floats), enums stay plain strings, ids come out of resource names, and free text (names, ad texts, URLs, search terms, keyword texts, labels) is wrapped as `{"untrusted": "..."}` by field type.
- A reader is named GAQL queries ("parts") + a row mapper + a summary builder. `runReader` reads every part up to a row cap (10,000 by default), builds the summary over every row read, sorts, and returns one page with a cursor.
- Each part gets a status: `ok`, `failed`, `not_allowed` (access level or account access) or `skipped`. When a part hits the cap, runs out of time or fails, `totalsPartial` is true and a note says why. A summary fact that depends on a part that was not read is `null`, never a false number.
- Replies stay small: a page is cut by rows and by bytes (~40 KB), embedded lists stop at 20 with a count, extra sections come on the first page only, and text over 300 characters is cut with `"truncated": true`.
- With a deadline, work that would not fit (follow-up queries, next Google pages) is skipped with a note instead of failing the call.
- Date ranges are one string: a preset (`LAST_30_DAYS`) or `2026-09-01..2026-09-30`, max 400 days. Dates, statuses and ids are checked again when the GAQL is built.
