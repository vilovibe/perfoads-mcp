# @perfoads/checks

Deterministic Google Ads account checks. No network, no AI, no database: the same input and run date give the same output, byte for byte, whatever order the rows arrive in.

- `runChecks(input)` runs every shipped check and returns scored findings plus one outcome per check: `finding`, `clean`, `not_run` (with the reason) or `suppressed` (found something, every finding held back, with the reasons). A check is never `clean` when its data was not read or was incomplete. It never throws: a rejected input (wrong types for brand terms, owner context, run date, status rows) returns `errors` and every check `not_run`.
- The checks say what is wrong (evidence, severity, the money at stake), never what to do about it. `runChecks(input, { remedies, writerHints })` accepts a caller's own `RemedyProvider` (a decision per check id, set on `Candidate.remediation`) and `WriterHints`; without them no result carries either.
- `listChecks()` and `explainCheck(id)` describe each check: what it needs, what it cites, its severity ceiling and the settings it reads.
- Input is a neutral `EvidenceInput`: account rows (`AccountData`), optional named tables, one status row per table read (`{ table_name, status: ok | failed | not_allowed | skipped, row_count }`; only `ok` is readable), optional row limits (`caps`), an optional account profile (brand terms, business type) and optional owner context (targets, constraints). Malformed rows (null, non-objects, cyclic or nested deeper than 32 levels) are dropped with a counted warning. Completeness covers every table a check depends on, parents included: a failed, skipped, short (row_count or legacy count above the rows provided, or at the caller's cap) or status-less table blocks a clean result (pass `assumeComplete: true` to vouch for tables without a status row).
- Judgement bars are defaults, not Google rules, and can be overridden per run (`settings`, see `DEFAULT_SETTINGS`). Every override is range-checked; a bad one keeps the default and appears in `warnings`, and every accepted change is listed in `settingsUsed`.
- Every finding is gated: business type, account size, entity status (paused things carry no finding), brand rules, learning age, volume floors, and the owner's own constraints.

Shipped checks: budget and bidding BB01-BB11, BB14-BB17; search keywords and search terms SK01-SK05.
