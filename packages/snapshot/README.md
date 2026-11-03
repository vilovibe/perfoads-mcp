# @perfoads/snapshot

A versioned `AccountSnapshot` (v1) of one Google Ads account, and the adapter that turns it into the check engine's input.

- `buildSnapshot(source, options)` runs every reader the shipped checks need (daily metrics, campaigns, ad groups, keywords, search terms, budgets and bidding, bid modifiers, bidding adjustments, change history, conversions), two at a time, inside a time budget. Each reader becomes one section with its status (`ok`, `failed`, `not_allowed`, `skipped`), row count, row limit, whether it was cut, and its rows. A reader that failed or had no time left is recorded as such, never as zero rows.
- Files: gzipped JSON at `<config dir>/snapshots/<customer id>/<snapshot id>.json.gz`, folders `0700`, files `0600`, never inside the working folder. Kept 24 hours, at most 20 per account. A damaged file, a file of another version, or a snapshot of another account is refused with a plain error.
- `toEvidenceInput(snapshot)` maps the sections to the engine's rows (snake_case, money as numbers, impression share as fractions), one status row per table (the worst status of the reader parts that feed it) and the readers' row limits. A table no reader produces gets no status row, so the checks that need it report "not run".
- `accountSnapshotJsonSchema()` returns the JSON Schema of the file format.
