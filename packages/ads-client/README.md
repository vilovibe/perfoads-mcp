# @perfoads/ads-client

REST client for the Google Ads API. No Google client library.

- One API version constant (`src/version.ts`).
- Injected token provider, fetch, logger (secrets redacted, stderr by default) and ops counter.
- Timeout on every request. Reads retry on 5xx, 429 and network errors (backoff + jitter, honours Retry-After).
- Writes are sent once. A timeout, reset or 5xx on a write throws `AdsInDoubtError`: read the account before doing anything else.
- Google errors become plain English, keeping the request id, error code and field path.
- `validateOnly`, `partialFailure` with per-operation results, `MUTABLE_RESOURCE`, atomic `GoogleAdsService.Mutate` with temporary ids, idempotent remove.
- Manager-account discovery with the login-customer-id for every account; Keyword Planner ideas (not on Explorer access).
- Money helpers on BigInt micros, rounded to Google's minimum unit per currency.
