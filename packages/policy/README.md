# @perfoads/policy

The change policy of the PerfoAds MCP server: `policy.yaml` in the settings folder (never a project folder), schema version 1, validated strictly (an unknown key or bad value makes the whole file invalid, and then the server is read-only).

- **No file, an invalid file, or a file inside a folder the AI works in** (the server's start folder or a workspace root the AI app shares) = read-only everywhere. `doctor` says which.
- **Re-read on every check** and parsed again when its hash changes; each new version is logged (`policy_loaded`, with its hash) and kept by hash in the store.
- **Checked at propose, at apply and again inside the claim transaction** (`BEGIN IMMEDIATE`, the same one that claims the change's items), so the kill switch, writes per minute / day and the rolling 24-hour spend limit see every claim committed before. Two parallel changes can't both pass `max_new_daily_spend`.
- **Spend.** `max_new_daily_spend` (per account, account currency) = budget raises + daily budgets of campaigns turned on, across every change claimed on the account in the last 24 hours (applying, applied, verified, in doubt ... all count) + this one. Missing for an account = spend can't go up there. Compared in micros (BigInt), never floats.
- **Undo** follows the same policy (kill switch, accounts, spend, rates). Only `max_budget_change_pct` / `max_target_change_pct` are not applied when the undo puts back exactly the stored old value (the change engine checks that).
- **Policy changed between propose and apply:** the change must pass both versions; the stricter tier wins.
- **Tiers:** `auto | confirm | blocked`, exact type or a pattern ending in `*`; default confirm. `auto` is honoured only for pausing a campaign and lowering budgets; anything else = confirm.
- **Ops reserve:** reads stop before the last `reserve_for_writes_pct` of today's Google Ads operations.
- `defaults` (`new_entities_paused`, `broad_match_requires_smart_bidding`) are validated and kept for future change types.
