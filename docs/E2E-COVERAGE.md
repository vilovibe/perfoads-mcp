# End-to-end coverage of the change types

Google Ads test accounts do not spend, have no metrics and no
Merchant Center. So every change type is covered in three layers:

- **Unit**: pure logic (input checks, safety rules, policy facts) with no Google at all.
- **Contract**: the real change engine and the real ads client against a fake Google
  account that answers with the documented REST shapes (GAQL rows, `mutateOperationResponses`,
  `partialFailureError`). Every lifecycle step runs: propose
  (validate only), approve, apply, read-back, undo, unclear answers and partial failure.
- **Live**: `scripts/e2e-live-mcp.mjs` on a real Google Ads **test** account, through the
  MCP server itself: propose_change, apply_change (approved on the real local approval page,
  driven like a browser), read-back, undo_change and its own approval and read-back. First
  run 2026-10-25: every type passes (results below). `scripts/e2e-test-account.mjs` is the
  older engine-only runner (env sign-in, CLI code path).

| #   | Type                          | Unit                                                                                                                                                                | Contract (fake account, real engine)                                                                                                                                                                                                                                                                                                                                                                   | Live test account                                                         |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1   | update_budget                 | amounts, currency rounding (`types.test.ts`)                                                                                                                        | shared budget expansion, read-back, undo, unclear answer, stale, busy resend (`engine.test.ts`, `types.test.ts`)                                                                                                                                                                                                                                                                                       | pass 2026-10-25                                                           |
| 2   | update_campaign_status        | REMOVED refused                                                                                                                                                     | enable counts as new spend, read-back, undo (`engine.test.ts`, `bypass.test.ts`)                                                                                                                                                                                                                                                                                                                       | pass 2026-10-25                                                           |
| 3   | update_bidding                | bounds, ratios                                                                                                                                                      | portfolio expansion, target caps, undo bounds (`types.test.ts`, `bypass.test.ts`)                                                                                                                                                                                                                                                                                                                      | pass 2026-10-25 (target CPA on Maximize conversions)                      |
| 4   | add_campaign_negatives        | safety rules: brand, converted searches/keywords, plurals (`negatives/safety.test.ts`)                                                                              | ops per campaign x negative, partial failure (per-item results, undo of what landed), safety refusal, override facts, brand from policy/input/account name, re-check before send, PMax searches required when a PMax campaign is reached (else a warning), all_conversions counted, override set hashed (stale on any change), unclear answer settled by change history, item locks (`types6.test.ts`) | pass 2026-10-25                                                           |
| 5   | remove_campaign_negatives     | input checks                                                                                                                                                        | remove by text + match type, undo adds back with the text as sent (`types6.test.ts`)                                                                                                                                                                                                                                                                                                                   | pass 2026-10-25 (removes a negative the campaign was made with)           |
| 6   | add_shared_negatives (+ link) | input checks                                                                                                                                                        | one atomic Mutate with temporary id -1 (list, words, link), campaigns on the list listed, linking checks the words already in it, undo removes the new list, stale undo (`types6.test.ts`)                                                                                                                                                                                                             | pass 2026-10-25                                                           |
| 7   | add_keywords / pause_keyword  | input checks                                                                                                                                                        | PAUSED by default, ENABLED only by policy, BROAD needs smart bidding, partial failure + undo of what landed, unclear answer with part landed, pause + undo (`types6.test.ts`)                                                                                                                                                                                                                          | pass 2026-10-25 (add, then pause)                                         |
| 8   | update_rsa_text               | 30/90/15 limits with wide characters, counts, pins, emoji, duplicates                                                                                               | one ad update with field mask, read-back passes while Google re-reviews, undo restores texts + pins (`types6.test.ts`)                                                                                                                                                                                                                                                                                 | pass 2026-10-25 (headlines + path)                                        |
| 9   | add_sitelinks / add_callouts  | URL, length, both descriptions, 20 per campaign                                                                                                                     | assets + links in one atomic Mutate with temporary ids, already-there = same text + URL + descriptions (same text, other URL refused), read-back compares content, undo unlinks by the resource names in Google's reply (assets stay: declared partial) (`types6.test.ts`)                                                                                                                             | pass 2026-10-25                                                           |
| 10  | add_audience_exclusions       | input checks                                                                                                                                                        | negative user list criterion, unknown list refused, undo removes (`types6.test.ts`)                                                                                                                                                                                                                                                                                                                    | pass 2026-10-25 (on a rule-based list the run makes)                      |
| 11  | create_campaign               | name, budget (own or shared), bidding, networks, locations, languages, ad group/keyword/RSA limits, MANUAL_CPC needs max_cpc, duplicates (`createCampaign.test.ts`) | one atomic Mutate with temporary ids (budget, campaign, criteria, ad groups, keywords, ads), always PAUSED, negatives safety gate, read-back by unique name compares every field and item, undo removes campaign + own budget only while unused, refused otherwise (`createCampaign.test.ts`); policy ops cap and new spend on turn-on (`packages/policy/src/createCampaign.test.ts`)                  | pass 2026-10-25 (made paused, read back, undo removes it with its budget) |

The approval view for these types (AI texts shown exactly as sent, the OVERRIDE banner,
what undo can do) and the per-type schemas at `schema://changes/{type}` are covered in
`packages/mcp-server/src/changeTypes6.test.ts`. Policy enforcement of the defaults
(`new_entities_paused`, `broad_match_requires_smart_bidding`) and `brand_terms`:
`packages/policy/src/evaluate.test.ts`, `source.test.ts`,
`schema.test.ts`.

## Undo per type

An undo is a new change with its own approval, proposed from the stored "before" values. Whether a change can be undone is decided when it is proposed and shown on its approval page. For every type, undo is refused when the change is older than 30 days, when its outcome is unclear (`in_doubt`, `verify_failed`), when it already has an undo, or when the item changed since. An undo itself can't be undone (propose the change again).

| Type                                                                  | Undo                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| update_budget, update_campaign_status                                 | full: the old value back                                                                                                                                                                                                                                                                                                                                 |
| update_bidding                                                        | full (the old strategy and target back), unless the approval page says it can't be undone: the campaign used a bidding strategy this server can't set (outside the supported list in `updateBidding.ts`), or Manual CPC with Enhanced CPC, which Google retired                                                                                          |
| add_campaign_negatives, add_shared_negatives, add_audience_exclusions | full: removes what landed (a new shared list is removed with it)                                                                                                                                                                                                                                                                                         |
| add_keywords                                                          | full (removes the keywords the change created; ones that already existed are left alone), unless the approval page says it can't be undone: undo is refused when those keywords are gone already ("nothing to undo"), and only what landed is removed after a partly applied change                                                                      |
| remove_campaign_negatives                                             | full: adds the negatives back as sent                                                                                                                                                                                                                                                                                                                    |
| pause_keyword                                                         | full: enables it again                                                                                                                                                                                                                                                                                                                                   |
| update_rsa_text                                                       | full: old texts, pins and paths                                                                                                                                                                                                                                                                                                                          |
| add_sitelinks, add_callouts                                           | partial: the campaign links the change made are removed; the assets stay in the account's asset library                                                                                                                                                                                                                                                  |
| create_campaign                                                       | full while unused: removes the new campaign with everything in it, and its own budget. Refused once the campaign was turned on, changed after it was made, or has impressions, clicks or spend; the answer then says to pause it with update_campaign_status. Offered from 15 minutes after it was made, once Google's change history shows the creation |

## Settled by the live run (2026-10-25)

The fake account answers in the documented shapes; these behaviours of the real Google Ads
API were assumed and are now confirmed on a test account:

1. **A campaign's own budget with no name is accepted** (the change does not name it): yes,
   create_campaign was accepted and read back.
2. **The undo removes the campaign and its own budget in one request**: yes, Google accepted
   it and the read-back found both gone.
3. **The all-time spend query (no date range)** that undo uses to prove the campaign never
   ran: valid, it returns one row per campaign (all zeros on a test account).
4. **change_event filtered by campaign finds a new ad**: yes, the query is valid and finds it
   (an ad added outside this server made the undo refuse with "Google's change history shows
   things were added"). Two limits seen on the test account: events showed up about 10
   minutes after the change, and the same query answered all rows, then no rows, then all
   rows again within a minute. So "no history rows" is not proof of no change; the undo's
   second check (reading the campaign's contents) caught the new ad in every run. Google's
   own device rows are not in the history. The undo of create_campaign now follows this
   rule (`createCampaign.test.ts`, the fake Google models the lag and the empty reads):
   - it reads the change history twice, 20 seconds apart (only when the apply deadline
     leaves time for it), and both reads must show this campaign's own creates (the
     campaign's create and one per ad group it made), nothing but creates, and the same
     events. Missing, part of them, or the two reads differing = refused: "Google's change
     history doesn't show this campaign's creation yet, so it can't confirm nothing else
     changed. Try the undo again in a few minutes." (refused and logged, not stale; at the
     re-check before sending it is stale with that reason and nothing is sent);
   - it is refused until 15 minutes after this server applied the create (its own stored
     UTC time, so clock changes in the account's zone don't shorten it), with the earliest
     time;
   - every earlier check stays (this server's own changes on it, what is attached to it,
     all-time results all zero, the campaign's contents).
   - known limit: a campaign switched on and back off outside this server, with the switch
     not in Google's history yet and all-time results still zero, can still be removed
     (see THREAT-MODEL.md, accepted risks).
5. **Sitelink URLs**: a URL typed as `https://WWW.Example.com` is sent as
   `https://www.example.com/` (lower-case host, `/` for an empty path) and Google keeps it
   exactly so; the read-back compares equal.

Found and fixed by the live run (each with a contract test; the fake Google now enforces the
first two rules):

- Google refuses a filter on another resource's field unless that field is selected too, on
  `campaign_asset`, `ad_group_asset`, `customer_asset`, `campaign_budget` and
  `geographic_view`. The snapshot's ads/assets and countries reads failed on every account,
  and create_campaign's undo could not read what was attached to the campaign.
- Google refuses removing a shared negative list a campaign still uses: the undo of
  add_shared_negatives (new list) now unlinks the campaigns first, in the same request.
- Google adds a device row (desktop, mobile, tablet) with no bid adjustment to every new
  campaign and ad group. The undo of create_campaign counted them as "added later" and
  refused; they are now skipped (a device row with an adjustment still counts).
- Maximize conversions and target CPA need conversion tracking: a new test account needs one
  conversion action first (the live script makes one once).

## Live run on a real account (2026-11-01)

`scripts/e2e-real-account.mjs` on a real, spending Google Ads account (owner-authorised), through the MCP server with the same approval page as above. Guards: it only changes items it creates in the run (two campaigns named `PerfoAds MCP test - do not enable ...`, $1/day own budgets, made paused, Search only), the run's policy allows writes on that one account only, approval pages must show that account and the live badge, and clean-up removes everything it made. Result: every type below verified, and every undo verified; create_campaign undo after 13 minutes of change-history wait; the switch-on of the run's campaign lasted about 3 seconds with 0 impressions and $0 spend; 385 live operations; nothing left in the account but one sitelink and one callout asset (Google keeps assets).

Types verified with their undo: update_campaign_status, update_budget, update_bidding, add_campaign_negatives, remove_campaign_negatives, add_shared_negatives (new list + link), add_keywords, pause_keyword, update_rsa_text, add_sitelinks, add_callouts, add_audience_exclusions (an existing website-visitor list, excluded on the run's campaign only), create_campaign (+ undo). Undo of a campaign changed after it was made is refused, as designed.

The first attempt the same evening showed the per-minute write limit (`limits.writes_per_minute`, default 10) working: steps sent faster than that were refused with "Try again in a minute", nothing sent. The script now paces itself and retries those refusals.

## Running the live test

```sh
pnpm install --frozen-lockfile && pnpm build
perfoads-mcp auth      # once: sign in with an account that reaches a Google Ads test account
node scripts/e2e-live-mcp.mjs
```

- It uses the saved sign-in and the test access level, and works only on a Google Ads test
  client account (`customer.test_account` true, not a manager). With more than one, set
  `E2E_CUSTOMER_ID`.
- For the run it writes `policy.yaml` in the settings folder allowing only that account; a
  file already there is moved aside and put back at the end (also on Ctrl-C).
- Approvals: the MCP client declares no forms, so apply_change opens the local approval page;
  the script GETs it over 127.0.0.1 and POSTs "approve" with the page's CSRF token, as a
  browser click does. Nothing in the server is bypassed.
- It never prints a secret, the approval page or its address. `E2E_OUT=<file>` saves the full
  results (they hold the test account's ids: keep that file out of the repo).
- Clean-up: the 3 campaigns it makes (with their budgets), the audience list and any
  `PerfoAds e2e` list left by a stopped run are removed. Sitelink and callout assets stay in
  the asset library (Google does not delete assets); the conversion action is kept.
- A run takes up to about 70 minutes: it waits for the change history (see point 4 above).
  Campaign A's undo is tried every 2 minutes for up to 30 minutes while it is refused for
  the history not being ready; the wait is in the results (`undoWaits`) and the step's note.
  The run policy lets reads use the whole daily operations allowance (15,000 a day for test
  accounts, counted locally apart from live accounts), so clean-up is not refused part way.

The older engine-only runner (env sign-in, temporary store):

```sh
E2E_OAUTH_CLIENT_ID=your-client-id \
E2E_OAUTH_CLIENT_SECRET=your-client-secret \
E2E_REFRESH_TOKEN=your-refresh-token \
E2E_CUSTOMER_ID=123-456-7890 \
node scripts/e2e-test-account.mjs
```
