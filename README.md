<img src="claude-plugin/.claude-plugin/icon.png" alt="PerfoAds MCP" width="96" height="96">

# PerfoAds MCP

A self-hosted MCP server that works with Google Ads. It lets an AI assistant (Claude Desktop, Claude Code, Cursor and other MCP apps) **read** your Google Ads accounts, run **100+ deterministic account checks**, and **change things only with your approval and within limits you set** in a policy file.

PerfoAds MCP works with Google Ads. It is not made, endorsed or supported by Google (not a Google product). It works with the Google Ads API through **your own** Google Cloud project and your own sign-in; nothing goes through anyone else's servers.

Package and CLI: `perfoads-mcp`. License: Apache-2.0. Status: early alpha (`0.2.0-alpha.0`), not published to npm yet.

## Work with Paweł

The checks say what is wrong: the evidence, how serious it is and the money it wastes. They do not say how to fix it. Want fixes, not just findings? PerfoAds adds fix plans; Paweł Wilk offers a free 1-hour call - perfoads.com

## The safety promise

No change can be applied through MCP without a human approving it outside the model. On hosts where the agent also has a shell or controls the browser (Claude Code, Cursor, browser-control tools) this holds only with the [hardened setup](docs/HARDENED-SETUP.md) (server + store under a separate OS user or in a container, `approval_mode: code_only` and `open_browser: false`), **and** only if you do the human steps (your password, approving, policy edits) from a session the AI can't change: another account's login session, SSH from another device, or with the AI agent sandboxed. An AI with a shell on your user can change your shell startup files, fake `sudo` and capture what you type.

The one exception is one you make yourself: the `auto` tier in your policy file (off unless you set it, and only for pausing a campaign or lowering a budget).

What this means in practice:

- Changes are **off** until your policy file lists an account under `accounts.write`.
- Google checks the change first without applying it (validate only). Then it is shown to you on a **local approval page** with the account name, id and currency first, the exact change, every campaign it reaches, and the AI's reason in a separate "unverified" box.
- You approve with the 6-character code from that page (typed into your AI app's form or a terminal), or a click on the page in apps without forms. An AI saying "yes" approves nothing.
- The server applies the change once, reads it back from Google, and logs every step in a hash-chained audit log. Most changes can be undone within 30 days (as a new approved change); see the [per-type table](docs/E2E-COVERAGE.md#undo-per-type).

Read [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for what this protects against and what it does not.

## Requirements

- Node.js **22.13 or later** (it uses the built-in `node:sqlite`).
- Your own **Google Cloud project** with the **Google Ads API** enabled.
- An **OAuth client of type "Desktop app"** in that project.
- **Explorer access** to the Google Ads API, applied for in Google Cloud Console for that project. Until it is approved, only Google Ads test accounts work. No developer token is needed.

Step by step: [docs/SETUP.md](docs/SETUP.md).

## Install and connect

> **Not on npm yet.** The package name `perfoads-mcp` is not published (or reserved) yet, so `npx perfoads-mcp ...` would fetch whatever someone else may publish under that name. Until the first release, install from source:
>
> ```sh
> git clone https://github.com/vilovibe/perfoads-mcp.git
> cd perfoads-mcp
> pnpm install --frozen-lockfile && pnpm build
> node packages/cli/bin/perfoads-mcp.js init
> ```
>
> `init` then prints your AI app's config for this copy: `"command": "<full path to node>"` with `"args": ["<full path>/packages/cli/bin/perfoads-mcp.js", "serve"]`, and for Claude Code `claude mcp add --scope user perfoads-mcp -- <full path to node> <full path>/packages/cli/bin/perfoads-mcp.js serve`. Wherever these docs say `npx perfoads-mcp@<version> <command>`, run `"<full path to node>" "<full path>/packages/cli/bin/perfoads-mcp.js" <command>`; every message, doctor fix and the approval page print exactly that command for your install.

Once it is on npm:

```sh
npx perfoads-mcp@<version> init
```

Always name the exact version (`@0.1.0`, not `@latest` or none), so npm can't hand you a different release. `init` asks for your OAuth client id and secret, opens Google's sign-in in your browser, saves the sign-in encrypted, writes a read-only starter policy, runs `doctor`, and prints the config for your AI app.

After the npm release, the AI app config is (until then use the `node` form above; `init` prints it with your version filled in):

**Claude Desktop** (Settings > Developer > Edit Config, `claude_desktop_config.json`), **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "perfoads-mcp": {
      "command": "npx",
      "args": ["-y", "perfoads-mcp@<version>", "serve"]
    }
  }
}
```

**Claude Code**:

```sh
claude mcp add --scope user perfoads-mcp -- npx -y perfoads-mcp@<version> serve
```

Or as a Claude Code plugin (it pins the release version; [claude-plugin/](claude-plugin/)):

```
/plugin install perfoads --marketplace vilovibe/perfoads-mcp
```

**ChatGPT desktop app and Codex**: they run local MCP servers too; see [docs/SETUP.md](docs/SETUP.md#chatgpt-desktop-and-codex).

More: [examples/](examples/) (Claude Desktop, Claude Code, Cursor, a starter policy). A Claude Desktop extension (`.mcpb`) can be built with `node scripts/build-mcpb.mjs`; run `init` in a terminal first, the extension uses the same settings folder.

Then ask your AI app: "run doctor", "list my Google Ads accounts", "audit account 123-456-7890".

## Quick tour

What to ask your AI, step by step: [docs/USING.md](docs/USING.md). Full list with every input: [docs/TOOLS.md](docs/TOOLS.md) (generated from the server).

- **Setup and accounts:** `doctor` (checks the setup and says what to fix), `list_accounts` (incl. accounts under manager accounts).
- **Reads:** `get_account_overview`, `get_campaigns`, `get_ad_groups`, `get_keywords`, `get_search_terms`, `get_budgets_and_bidding`, `get_negatives`, `get_ads_and_assets`, `get_audiences`, `get_conversions`, `get_change_history`, `keyword_ideas`, `describe_resource`, and `query_gaql` (one read-only GAQL `SELECT`). Summary first, then one page of rows and a cursor. Money is a decimal string in the account currency.
- **Checks:** `build_snapshot` reads what the checks need into a local snapshot, `run_checks` runs them (findings with evidence; "not run" with the reason, never "clean" when data was missing), `explain_check`. Prompt `weekly_audit`. Catalog: [docs/CHECKS.md](docs/CHECKS.md).
- **Changes:** `propose_change`, `apply_change`, `undo_change`, `get_change`, `list_changes`, `resolve_change`. Types: budgets, campaign status, bidding targets, negatives (campaign and shared lists), keywords, pausing keywords, responsive search ad text, sitelinks, callouts, audience exclusions, and creating a new Search campaign from plain fields (always made paused; undo only while it never ran).

Text that comes from Google or the AI (names, search terms, ad texts, errors) is wrapped as `{"untrusted": "..."}` so the AI treats it as data, not instructions.

## How a change works

1. **Propose** - the AI suggests a change. The server reads the live values, checks your policy, and asks Google to validate it without changing anything.
2. **Approve** - the server opens a local approval page (127.0.0.1, one-time link, 10 minutes), or, with `open_browser: false`, you open it yourself with `approvals open <id>` in a terminal. You approve with its code, or reject.
3. **Apply** - sent once. If the account changed since you approved, nothing is sent (`stale`). An unclear answer from Google is never re-sent: it is re-checked by reading the account.
4. **Read back** - the server reads the account again to confirm the change landed (`verified`), or says loudly that it did not.
5. **Log and undo** - every step is in the audit log (`changes://log`); `undo_change` proposes the reverse as a new change, with its own approval.

Approval paths and `approval_mode`: see [docs/HARDENED-SETUP.md](docs/HARDENED-SETUP.md#approval-modes).

## The policy file

`policy.yaml` in the settings folder decides which accounts the AI may read and change and how far: per-account spend limits in the account's currency, budget and target step limits, writes per minute and day, tiers per change type (`auto`, `confirm`, `blocked`), brand terms that are never negated, a Google Ads operations reserve for changes, and a kill switch. It is re-read on every check, and no tool can edit it.

```sh
npx perfoads-mcp@<version> policy check   # is it valid, and what does it allow?
npx perfoads-mcp@<version> policy show    # what the server uses now
```

Every key, range and default, with examples: [docs/POLICY.md](docs/POLICY.md). Starter file: [examples/policy.example.yaml](examples/policy.example.yaml).

## What is stored, and how to delete it

Everything lives in one settings folder, never in your project: `~/.config/perfoads-mcp` (or `$XDG_CONFIG_HOME/perfoads-mcp`), `%APPDATA%\perfoads-mcp` on Windows. Change it with `PERFOADS_MCP_HOME`, but keep it outside any folder the AI works in (`doctor` checks).

- `store.sqlite` - your OAuth client id, client secret and refresh token (each encrypted, AES-256-GCM), the list of your accounts, proposed and applied changes, approval sessions (codes only as hashes), the audit log, Google Ads operations used, and every policy version loaded.
- `snapshots/` - account snapshots for the checks (gzipped JSON, owner-only, kept 24 hours, at most 20). They hold account data such as campaign names and search terms.
- `policy.yaml` - your change policy. `config.json` - optional `approval_mode`, `open_browser`, `retention_days` and `pro_plugin` (an absolute path to a separately installed plugin package, loaded at start; a plugin runs as code with the server's rights, so set it only for a package you trust; it is refused when anyone but the user running the server, or root, can change its files or a folder above them; its text comes back wrapped as untrusted; `doctor` shows whether it loaded and why not).
- **Kept for 180 days** by default (`"retention_days"` in `config.json`, 30 to 3650): when the server starts, changes in a final state (verified, failed, rejected, expired, stale, settled, abandoned), finished approval sessions, policy versions nothing still refers to, and the oldest audit log entries, all older than that, are deleted. Unfinished changes (proposed, approved, applying, in doubt, applied but not yet checked) and anything they need are never deleted. Before deleting, the server writes a `retention_pruned` entry to the audit log with what it removes and a checkpoint (the number and hash of the last entry removed), so the rest of the log still verifies. Snapshot temp files from interrupted saves go after 1 hour.
- The encryption key: macOS Keychain, the Linux keyring (`secret-tool`), or a key file (`key`) in the settings folder (always the key file on Windows).
- Owner-only, per OS: on macOS and Linux the store files, the key file, snapshot files and the starter `policy.yaml` are created `0600` and snapshot folders `0700` (a `config.json` you write yourself keeps the mode you give it). On Windows file modes do nothing, so each time the store opens the server sets an ACL on the whole settings folder with `%SystemRoot%\System32\icacls.exe`: inheritance from the parent removed, full control for your Windows user only, applied to everything already in it and inherited by everything created later (store, key file, snapshots, `policy.yaml`, `config.json`); the key file, snapshot folders and files and the starter policy get it again when they are written. `doctor` warns on Windows when the settings folder is outside `%APPDATA%`, and fails (with the fix) when `icacls` could not make it owner-only.

**Tokens are encrypted** at rest and never written to logs or shown in tool results. Encryption protects a copy of the folder (a backup, a synced folder). It does **not** protect against programs running as your own OS user: the Keychain entry, the keyring entry and the key file can be read by any process of the same user without a prompt, including an AI agent with a terminal. The [hardened setup](docs/HARDENED-SETUP.md) closes that, within its stated limits (human steps from a session the AI can't change).

**Disconnect and delete:** `npx perfoads-mcp@<version> reset` asks Google to revoke the saved sign-in (best effort; it says whether Google confirmed), then deletes the sign-in and its key (it asks first). Delete the settings folder to remove everything else. If `reset` says Google did not confirm, remove the app's access at myaccount.google.com/permissions.

Nothing is sent anywhere except to Google's APIs. No telemetry.

## Commands

```
perfoads-mcp init                    guided setup
perfoads-mcp auth                    sign in again (uses the saved OAuth client)
perfoads-mcp doctor                  check the setup
perfoads-mcp reset                   delete the saved sign-in and its key (asks first)
perfoads-mcp serve                   run the MCP server over stdio (AI apps start this)
perfoads-mcp approve <change_id>     approve with the code from the approval page (terminal only)
perfoads-mcp reject <change_id>      reject a proposed change (terminal only)
perfoads-mcp approvals open <id>     show a change's approval page from this terminal
perfoads-mcp policy check [file]     check a policy file and say what it allows
perfoads-mcp policy show             the change policy the server uses now
```

Use `npx perfoads-mcp@<version> <command>` (or the command `init` printed) if it is not installed globally.

## Known limits

- **Alpha.** The Google Ads queries and writes are tested against recorded and fake replies. Live runs passed on a Google Ads test account (2026-10-25, every change type with its undo) and read-only on 4 real accounts (2026-10-26), and every change type with its undo on a real account (2026-11-01, $0 spent). Coverage per change type: [docs/E2E-COVERAGE.md](docs/E2E-COVERAGE.md).
- **Same OS user, no hardened setup:** an AI with a shell can read the store and key, start its own copy of the server, edit the policy, and fake a terminal (`approve` and `approvals open` are a convenience, not a guard). An AI that controls your browser can read the approval page, code included. Until you open it, the page link is visible for a moment in the browser opener's command line (`ps`) and stays in browser history; it stops working after the first open.
- **Access levels:** Explorer access allows 2,880 operations a day on live accounts (15,000 on test accounts, counted separately) and no Keyword Planner (`keyword_ideas` needs Basic or Standard). The server keeps a share of each day's operations for approved changes.
- **OAuth app in "Testing" mode:** Google ends the sign-in after 7 days. `init` and `doctor` warn; publish the app to production to avoid it ([docs/SETUP.md](docs/SETUP.md#testing-vs-production)).
- **Unclear outcomes:** changes to portfolio bidding strategies and shared negative lists can't be settled from Google's change history; after an unclear answer they stay `in_doubt` until the new value shows, you settle them (`resolve_change`), or 30 days pass.
- **Change history** reads at most 28 days. Every tool answers within about 4 minutes; very large accounts get samples, marked as such, and checks on a sample never say "clean".
- Not supported yet: ChatGPT on the web (needs a remote server; the ChatGPT desktop app and Codex work), remote or team use, Merchant Center, billing.

## Privacy Policy

PerfoAds MCP runs on your computer. Your Google Ads data goes only between your computer and Google; nothing is sent to PerfoAds, and there is no telemetry. What is stored locally, for how long, and how to delete it: [What is stored, and how to delete it](#what-is-stored-and-how-to-delete-it). Full policy: https://perfoads.com/privacypolicy

Terms of service: https://perfoads.com/termsofservice (the PerfoAds MCP section: free, as is, no warranty, Apache-2.0, your own Google account and costs, you approve every change).

Contact: contact@perfoads.com for privacy and security questions (security reports: see [SECURITY.md](SECURITY.md)). Bugs and support: https://github.com/vilovibe/perfoads-mcp/issues

## Docs

- [Using it](docs/USING.md) - what to ask your AI: look around, audit, change, launch, undo.
- [Setup and user guide (plain English, HTML + PDF)](docs/guide/PerfoAds-MCP-Guide.html) - the whole thing in one page for non-developers.
- [Setup](docs/SETUP.md) - Cloud project, OAuth client, Explorer access, Testing vs Production, ChatGPT desktop and Codex.
- [Release](docs/RELEASE.md) - npm, MCP Registry, GitHub release with the `.mcpb`.
- [Hardened setup](docs/HARDENED-SETUP.md) - separate OS user, SSH or container recipes; approval modes.
- [Policy](docs/POLICY.md) - every key, range and default.
- [Tools](docs/TOOLS.md) and [Checks](docs/CHECKS.md) - generated from the code.
- [Threat model](docs/THREAT-MODEL.md), [Security policy](SECURITY.md), [Changelog](CHANGELOG.md), [Naming](docs/NAMING.md).

Packages: `ads-client`, `reads`, `snapshot`, `checks`, `changes`, `policy`, `store`, `mcp-server`, `cli` (see `packages/`). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

- You are free to use, change, share and sell it, for any purpose.
- Keep the licence and the NOTICE file with any copy you share, and say what you changed.
- It comes with no warranty.

Google Ads is a trademark of Google LLC.
