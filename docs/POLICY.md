# The policy file

`policy.yaml` decides which Google Ads accounts the AI may read and change, and how far. Schema version 1.

```sh
npx perfoads-mcp@<version> policy check [file]   # valid? what does it allow?
npx perfoads-mcp@<version> policy show           # the policy the server uses now
```

The AI can read it (resource `policy://current`: values, version hash and a plain summary, file name only), but no tool can change it.

## Where it lives, and when it counts

- **Only** `policy.yaml` in the settings folder (`~/.config/perfoads-mcp`, `%APPDATA%\perfoads-mcp`, or `PERFOADS_MCP_HOME`). A file anywhere else is never read.
- The server **ignores** it (and `doctor` fails) when the settings folder sits inside a workspace folder your AI app shares (MCP roots), inside the folder the server was started in when that folder is below your home folder, or when `policy.yaml` has more than one hard link. A start folder that is your home folder, above it, or a drive root only gives a `doctor` warning.
- It is **read again on every check** (at most 64 KB). An edit, the kill switch included, counts from the next check on. Each new version is logged with its hash (`policy_loaded`) and kept in the store.
- **No file** = read-only everywhere: every account the sign-in reaches can be read, nothing can be changed.
- **Invalid file** (YAML error, unknown key, wrong value, duplicate key) = the whole file is invalid, never "partly valid": nothing can be changed, reads stay limited to the accounts of the last valid version (none if it was never valid), `doctor` fails. YAML 1.2 core schema; anchors, aliases and merge keys are refused.
- **Ignored file** = treated like no file, except that it can only narrow reads (to its own `allow` list and the last valid version's), never widen them.
- Checks run at **propose**, at **apply**, and again **inside the database transaction that claims the change**, so two changes applied at the same moment can't both use the last of a limit. If the file changed between propose and apply, the change must pass **both** versions (the stricter tier wins).
- An AI with a terminal on your user account can edit this file. The [hardened setup](HARDENED-SETUP.md) is what makes it binding.

## Keys

Account ids are **quoted strings**, 10 digits, dashes allowed: `"123-456-7890"`. Amounts are in **each account's own currency**, more than 0, at most 6 decimals, compared exactly (in micros), never as floats.

### `version` (required)

Always `1`.

### `accounts` (required)

| Key     | Type                    | Default | Meaning                                                                                                                                                          |
| ------- | ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow` | list of ids (max 1,000) | `[]`    | Accounts the AI may read.                                                                                                                                        |
| `write` | list of ids (max 1,000) | `[]`    | Accounts that may be changed (each change still needs your approval). Implies read. Also what lets changes reach accounts that are not Google Ads test accounts. |

With a policy file, the AI can read only accounts in `allow` or `write` (every read tool, snapshots and the snapshot resources).

### `limits`

All optional; a missing key takes the default.

| Key                     | Type             | Range          | Default | Meaning                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------- | -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_budget_change_pct` | number           | > 0 to 1,000   | 30      | Biggest budget step in one change, in percent of the current budget. Applies to raises **and** cuts.                                                                                                                                                                                         |
| `max_budget_change_abs` | map id -> amount | > 0            | none    | Biggest budget step in one change, in money. No entry = no money cap (the percent cap still applies).                                                                                                                                                                                        |
| `max_new_daily_spend`   | map id -> amount | > 0            | none    | Most extra daily spend over any 24 hours: budget raises + daily budgets of campaigns turned on, across every change sent to the account in the last 24 hours (including ones whose result is unclear) plus this one. Cuts don't make room. **No entry = spend can't go up on that account.** |
| `max_target_change_pct` | number           | > 0 to 1,000   | 20      | Biggest target CPA / target ROAS step in one change (campaign or portfolio strategy). Removing a target, or switching between target CPA and target ROAS, is refused (the step can't be measured), except an exact undo.                                                                     |
| `writes_per_day`        | whole number     | 1 to 1,000,000 | 50      | Changes applied per account per 24 hours (any status).                                                                                                                                                                                                                                       |
| `writes_per_minute`     | whole number     | 1 to 1,000,000 | 10      | Changes applied per account per minute.                                                                                                                                                                                                                                                      |
| `max_ops_per_change`    | whole number     | 1 to 10,000    | 200     | Google Ads operations in one change.                                                                                                                                                                                                                                                         |
| `proposals_per_minute`  | whole number     | 1 to 1,000     | 20      | New proposals per account per minute. Counted in the store before Google is asked, so parallel calls can't slip past; failed attempts count; undo not counted.                                                                                                                               |
| `proposals_per_day`     | whole number     | 1 to 100,000   | 200     | New proposals per account per 24 hours.                                                                                                                                                                                                                                                      |
| `undo_per_day`          | whole number     | 1 to 10,000    | 50      | Undo attempts per account per 24 hours. Each change also has fixed caps: 3 undo attempts a minute, 20 a day.                                                                                                                                                                                 |

`max_budget_change_abs`, `max_new_daily_spend` (and `brand_terms`) may only name accounts that are in `allow` or `write`.

**Undo** follows the same policy (kill switch, accounts, spend, rates). Only the percent limits are skipped when the undo puts back exactly the stored old value.

### `defaults`

| Key                                  | Type    | Default | Meaning                                                                                                                     |
| ------------------------------------ | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `new_entities_paused`                | boolean | `true`  | New keywords are created paused. A change that would create something enabled is refused while this is `true`.              |
| `broad_match_requires_smart_bidding` | boolean | `true`  | BROAD keywords are refused in campaigns without Smart Bidding (Target CPA / ROAS, Maximize conversions / conversion value). |

Both are applied while the change is built and checked again by the policy.

### `brand_terms`

Map of account id -> list of words (1-80 characters each, at most 100 per account, each with a letter or digit). Negative keywords that would block your brand are always refused, never overridable.

- Your terms **replace** the fallback: with no `brand_terms` for an account, its account name stands in (with a warning).
- The AI can **add** brand words to a change (`brand_terms` in the change input), never remove yours.
- Brands match as whole words; "&" counts as "and". The whole brand written together or apart counts too ("hm", "h m jeans" for H&M; "3 m" for 3M), but only as exact whole words ("hmm", "ham", "3mm" don't match). Plurals and accents are folded for every brand; brand words of 5+ letters also match other word endings, and of 7+ letters one typo. Brand words of 3+ letters count on their own, generic words like "shop" or "store" aside (a negative "northwind" blocks "Northwind Traders"); shorter ones only as the whole brand.

Negatives that would block a search or keyword with conversions in the last 90 days are refused too, unless the AI asks to override (`override_blocked_conversions`); the approval page then shows a red OVERRIDE banner with examples.

### `tiers`

Map of change type (or a pattern ending in `*`, or `*`) -> `auto`, `confirm` or `blocked`. Default `confirm` for every type.

- `confirm` - a person approves on the approval page.
- `blocked` - refused at propose.
- `auto` - applied without a person, but **only** for low-risk changes: pausing a campaign, or lowering a budget (no campaign turned on, no target touched). Anything else under `auto` is treated as `confirm`. An auto change still goes through Google's validate-only check, the claim, read-back and the log, recorded as approved by `policy_auto` with the policy hash.

Change types: `update_budget`, `update_campaign_status`, `update_bidding`, `add_campaign_negatives`, `remove_campaign_negatives`, `add_shared_negatives`, `add_keywords`, `pause_keyword`, `update_rsa_text`, `add_sitelinks`, `add_callouts`, `add_audience_exclusions`, `create_campaign`, `tag_exclude`. The params of each: resource `schema://changes/{type}`.

`create_campaign` makes a new Search campaign in one atomic request (budget, campaign, locations, languages, negatives, up to 20 ad groups with up to 100 keywords and one responsive search ad each). How the policy treats it:

- Tier: `confirm` by default. Under `auto` it is still treated as `confirm` (a person always approves a new campaign).
- Limits: every operation of the one request counts against `max_ops_per_change`; `writes_per_day`, `writes_per_minute` and the proposal limits apply as for any change. Campaign negatives go through the same brand and converted-search rules as `add_campaign_negatives`; BROAD keywords follow `broad_match_requires_smart_bidding`.
- Paused at creation: the campaign is always made PAUSED, whatever `new_entities_paused` says. Its ad groups, keywords and ads are enabled inside it, so nothing shows or spends.
- New spend: making it is not new spend. Turning it on later is a separate `update_campaign_status` change, and that change counts the campaign's daily budget against `max_new_daily_spend`.

Undo of an `add_*` change stays the same type, so `"remove_*": blocked` does not block undoing an add.

### `ops_budget`

Google Ads counts operations per day per Cloud project, live accounts and test accounts separately (Explorer: 2,880 a day on live accounts, 15,000 on test accounts; Basic: 15,000 each; Standard: no limit). An account counts as live until Google has said it is a test account. Both keys apply to each count on its own: reads on test accounts never use up the reserve of live accounts, and the other way round.

| Key                      | Type   | Range      | Default | Meaning                                                                                                                                                                                      |
| ------------------------ | ------ | ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warn_at_pct`            | number | > 0 to 100 | 80      | `doctor` warns when today's operations pass this share.                                                                                                                                      |
| `reserve_for_writes_pct` | number | 0 to 90    | 20      | Reads (and new proposals) stop before they would use this last share, so approved changes can still be sent and read back. Undo proposals and applying an approved change may use all of it. |

### `kill_switch`

`true` refuses every change, undo included, at every stage (propose, before the approval page, apply, claim). Default `false`.

## Examples

Read-only on two accounts (what `init` writes, without the comments):

```yaml
version: 1
accounts:
  allow: ["123-456-7890", "111-111-1111"]
  write: []
```

Changes on one **test** account, small steps, removals blocked:

```yaml
version: 1
accounts:
  allow: ["123-456-7890"]
  write: ["123-456-7890"]
limits:
  max_budget_change_pct: 20
  max_budget_change_abs: { "123-456-7890": 25 }
  max_new_daily_spend: { "123-456-7890": 50 }
  writes_per_day: 20
brand_terms: { "123-456-7890": ["Your Brand"] }
tiers:
  "remove_*": blocked
  update_bidding: confirm
kill_switch: false
```

Pausing campaigns and lowering budgets without a person (everything else still needs one):

```yaml
version: 1
accounts: { allow: ["123-456-7890"], write: ["123-456-7890"] }
tiers:
  update_campaign_status: auto
  update_budget: auto
```

Stop everything now:

```yaml
kill_switch: true
```

(add it to your existing file; the next check refuses every change).

Starter file with every key commented: [examples/policy.example.yaml](../examples/policy.example.yaml).
