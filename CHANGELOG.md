# Changelog

All notable changes to this project. Versions follow semver; all packages are released together.

## 0.2.0-alpha.0 (unreleased)

### Added

- **Product waste check, per campaign.** SH04 (Shopping) and PX05 (Performance Max) now look at each campaign's own product rows and judge them by that campaign's own cost of a sale. You see three kinds of finding per campaign: products that spent past the bar with no sale, products that sell but lose money (sales under their ad cost), and whole categories (by product type, else Google category) that lose money. Sizes of one product are added up per model and colour, so a selling colour never hides a wasting one. The colour comes from Merchant Center where known, else from the product titles with the size left out; each finding says which. Every product is listed with its own spend, names exactly as Google Ads shows them. When the read was cut short or a campaign has no bar, the check says "could not check", never "none found".
- **`tag_exclude` change type: stop showing chosen products.** Give it the Merchant Center id, the item ids and the campaigns. It writes one "exclude" custom label on those products in a Merchant Center source the connector makes for itself (it never edits your main feed or a source you made), checks first on every campaign's product groups that the label really stops them, and where it can't, excludes the item ids in the campaign's listing groups instead. Same approval page, read-back and undo as every other change; undo puts the old labels and product groups back. Label changes can take a few hours to show in Merchant Center.
- **Merchant Center access is opt-in.** `tag_exclude` needs it; nothing else does. To grant it, run `auth --merchant-center` once and tick the Merchant Center box on Google's screen. Plain `auth` and `init` still ask for Google Ads only and keep an access you already granted. `doctor` shows "Merchant Center labels (optional)" as on or off; without it, `tag_exclude` is refused with these steps.

### Fixed

- **No switch to value bidding under Google's conversion minimum.** Google refuses Maximize conversion value (with or without a target ROAS) on a campaign with too few recent conversions. BB14 now advises the switch only when the campaign has at least `bidding.targetRoasMinConv30d` (30) conversions in the last 30 days. Under it, BB14 gives a Note of its own for that campaign (keep the current bidding until it has about 30 sales in 30 days; no money, no change offered), never a clean result; with no 30-day series it is not run. `update_bidding` refuses a switch into value bidding from a strategy that is not value bidding under the same 30 before Google is asked; Target ROAS to Maximize conversion value with no target, and an undo, are not gated.

### Removed

- **Google's own suggestions ("recommendations").** They are no longer part of PerfoAds MCP: the `apply_recommendation` change type, the `get_recommendations` read tool, check AS05 (pending Google recommendations), check SH07 (price above Google's suggested price; now 160 checks), Google's suggested-budget and suggested-price fields from the check model, the snapshot's `recommendations` section, `recommendation` in `query_gaql`, and the ads client's recommendation apply/dismiss calls. Kept: check AS04 (warns when Google auto-applies changes) and the change-history checks that spot auto-applied changes.

## 0.1.0-alpha.0 (unreleased)

First alpha. Not published to npm yet.

### Added

- **Setup:** `init` (own Google Cloud project and Desktop OAuth client, PKCE sign-in, access level, starter policy, config snippets), `auth`, `doctor` (Node, settings folder, sign-in, OAuth Testing mode, access level, ops budget, policy, approval page, elicitation, risky hooks, browser-control tools), `reset`. No developer token.
- **Store:** one settings folder outside the project; SQLite (`node:sqlite`, WAL); credentials encrypted with AES-256-GCM, key in the macOS Keychain, Linux keyring or an owner-only key file.
- **Reads:** `list_accounts`, `query_gaql` (SELECT-only, known resources, personal-data fields refused), 12 typed `get_*` reads, `keyword_ideas`, `describe_resource`. Summaries over everything read, paged rows with cursors, money as decimal strings, Google text wrapped as untrusted, honest "not read" parts.
- **Checks:** `build_snapshot`, `run_checks`, `explain_check`, prompt `weekly_audit`, resources `snapshot://` and `checks://catalog`. 100+ deterministic checks; "not run" with a reason whenever data was missing or cut, never "clean".
- **Changes:** `propose_change`, `apply_change`, `undo_change`, `get_change`, `list_changes`, `resolve_change`, resources `changes://log` and `changes://{id}`. 13 change types: budgets, campaign status, bidding targets, campaign and shared negatives (with brand and converting-search safety), keywords, pausing keywords, responsive search ad text, sitelinks, callouts, audience exclusions, new Search campaigns (`create_campaign`, created paused). Google validate-only check on every change, local approval page with a typed code, apply once, read-back, hash-chained audit log, undo, `in_doubt` handling without blind retries.
- **Plugin (optional):** `pro_plugin` in `config.json` (an absolute path to a built plugin package, or an installed package name; never an environment variable or a tool input) loads a plugin at start. A plugin can add a decision per finding to `run_checks` (`remediation`, and a short `todayList` on the first page; the served result schema shows them only then), writer hints, prompts and read-only tools. Every text a plugin returns is wrapped as untrusted. A plugin whose files (or a folder above them, or anything they link to) another user could change is refused (Windows: it must sit in the settings folder). A missing, unsafe or broken plugin is one warning on stderr and the server runs exactly as without it. `doctor` says loaded, not configured, or why it failed. No plugin ships with this project.
- **Policy:** `policy.yaml` (accounts, per-currency spend limits, step limits, rates, defaults, brand terms, tiers, ops reserve, kill switch), `policy check`, `policy show`, resource `policy://current`.
- **Licence:** Functional Source License 1.1 with an Apache 2.0 future licence (FSL-1.1-ALv2); each release becomes Apache-2.0 two years after it ships.
- **Docs:** setup, hardened setup, policy, generated tools and checks references, threat model, examples for Claude Desktop, Claude Code and Cursor; a Claude Desktop extension (`.mcpb`) build script.

### Changed

- **Checks library:** the checks report what is wrong (evidence, severity, money at stake) and no longer carry fix guidance. `CheckDefinition.remediate` and `mustConsider` are gone. `runChecks(input, options?)` takes an optional `remedies` (`RemedyProvider`, a decision per check id, set on `Candidate.remediation`) and `writerHints` (`WriterHints.clientConstraint`); without them no result carries a remediation and the always-on gate stamps its facts only. A remedy gets a deep-frozen copy of the finding; a remedy or hint that throws or returns bad output is ignored and the finding is unchanged. New unstable entry `@perfoads/checks/internal` (not public API). MI12 rows lose their `fix` cell and SK07 rows their `action` cell; SH05 is now "product returning far more than the account".
- **Licence:** back to Apache-2.0 (licensor Paweł Wilk), replacing the licence above. LICENSE, NOTICE, every source header and every package now say Apache-2.0.
- **Name:** the product is now **PerfoAds MCP** (it works with Google Ads; "Google" is in no product, package or repository name). npm package and CLI `perfoads-mcp` (the `perfoads-google-ads-mcp` bin is gone; nothing was published under it), repository `vilovibe/perfoads-mcp`, MCP server id `perfoads-mcp`. Settings folder and Keychain entry are unchanged, so existing sign-ins keep working.
- **Listings:** `server.json` for the official MCP Registry (`com.perfoads/mcp`, `mcpName` in the CLI package), a Claude Code plugin and marketplace (`claude-plugin/`, `.claude-plugin/marketplace.json`), `privacy_policies` in the `.mcpb` manifest, ChatGPT desktop and Codex setup, and docs/RELEASE.md.
- **Work with Paweł:** one line in the README, the CLI help and the end of `init`, and the approval page footer.

### Known limits

- Not yet run against a live Google Ads account (see the README's known limits).
