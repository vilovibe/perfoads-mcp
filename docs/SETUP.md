# Setup

You need your own Google Cloud project. The server talks to the Google Ads API with an OAuth client you create and a sign-in you give it. No developer token is needed (Google made it optional and ignored it in September 2026); your API access level comes from the Cloud project that owns the OAuth client.

Time: about 15 minutes, plus Google's review of your Explorer access application.

## 1. Install Node.js

Node.js **22.13 or later** (the server uses the built-in `node:sqlite`). Check with `node --version`. Get it from nodejs.org or your package manager.

## 2. Create a Google Cloud project

1. Open console.cloud.google.com and sign in with the Google account that should own the project.
2. Create a project (or pick one you own). One project per integration: don't reuse a project that belongs to someone else's tool.

## 3. Enable the Google Ads API

APIs & Services > Library > search "Google Ads API" > **Enable**.

## 4. Set up the OAuth consent screen

Google Auth Platform (APIs & Services > OAuth consent screen):

1. User type **External** is fine (Internal only exists for Google Workspace organisations).
2. App name: anything you recognise, e.g. "My PerfoAds MCP". Add your email as support and developer contact.
3. Scopes: you don't have to add any here; the server asks for the Google Ads scope (`https://www.googleapis.com/auth/adwords`) at sign-in.
4. Audience / test users: while the app is in **Testing**, add the Google account you will sign in with as a test user.

## 5. Create the OAuth client

Google Auth Platform > Clients > **Create client** > Application type **Desktop app**. Keep the **client id** and **client secret** at hand. Don't commit them anywhere; `init` stores them encrypted.

The sign-in uses Google's installed-app flow with PKCE: your browser opens Google's page, and Google sends the answer back to a one-shot listener on `127.0.0.1` on your computer.

## 6. Apply for Explorer access

In Google Cloud Console, on the Google Ads API page of your project, apply for **Explorer** access. Until it is approved:

- only Google Ads **test accounts** work (a live account answers `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`; `doctor` explains it);
- that is enough to try everything on a test account.

Access levels, as Google defines them:

| Level    | What you get                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test     | Test accounts only, 15,000 operations a day.                                                                                                      |
| Explorer | Live accounts, 2,880 operations a day; test accounts, 15,000 a day. No Keyword Planner, audience reach, user management, billing or new accounts. |
| Basic    | 15,000 operations a day on live accounts and 15,000 on test accounts (needs brand verification of the Cloud project).                             |
| Standard | No daily cap.                                                                                                                                     |

Google counts operations on test accounts and on live accounts separately, and so does the server. An account counts as live until the server has seen Google say it is a test account (`customer.test_account`, read when it lists your accounts).

**The limit is yours alone.** It belongs to your own Google Cloud project, so other PerfoAds MCP users never use up your share, and you never use up theirs.

**How far 2,880 goes.** Everyday questions about one account use a few hundred requests a day. Heavy days use far more: a product-by-product review of a big Shopping or Performance Max account over several months can use 2,000+ requests on its own. If you hit the limit, the server stops reading and says when it refills (within a day). If you hit it often, get **Basic**: in Google Cloud Console, first complete brand verification for your project (Google Auth Platform > Branding: app name, logo, home page, privacy page), then on the Google Ads API Overview page click **Apply for access** under Basic.

Google's API does not report your level. `init` asks for it, `doctor` shows what it means; set it later with `PERFOADS_MCP_ACCESS_LEVEL` (`test`, `explorer`, `basic`, `standard`).

## 7. Run init

Not on npm yet: until the first release, build from source (README, "Install and connect") and run `node <full path>/packages/cli/bin/perfoads-mcp.js init` instead of the `npx` command; from then on use the command it prints.

```sh
npx perfoads-mcp@<version> init
```

It:

1. asks for the client id and secret (the secret is typed hidden),
2. asks for your access level,
3. opens Google's sign-in in your browser (if it does not open, it prints the link to copy),
4. saves the client and the refresh token, encrypted, in the settings folder,
5. writes a read-only starter `policy.yaml` (never overwrites one),
6. runs `doctor`,
7. prints the config for Claude Desktop, Claude Code and Cursor.

Restart your AI app after adding the config. Then ask it to "run doctor".

## Testing vs Production

An OAuth app whose publishing status is **Testing** gets refresh tokens that **expire after 7 days**. The server then can't reach Google until you sign in again (`npx perfoads-mcp@<version> auth`). `init` and `doctor` detect this and say when it ends.

To avoid it, set the app to **In production** (Google Auth Platform > Audience > Publish app). For the Google Ads scope Google may show an "unverified app" warning on the sign-in page until the app is verified; for an app only you use, you can continue past it. You don't need verification to use your own accounts.

## Settings folder

`~/.config/perfoads-mcp` (or `$XDG_CONFIG_HOME/perfoads-mcp`), `%APPDATA%\perfoads-mcp` on Windows. Change it with `PERFOADS_MCP_HOME` for both `init` and the AI app. Keep it outside any folder the AI works in: a policy file inside a workspace folder is ignored and `doctor` fails.

Environment variables:

| Variable                                                                             | What it does                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `PERFOADS_MCP_HOME`                                                                  | Settings folder. Empty = the default.                                                                  |
| `PERFOADS_MCP_ACCESS_LEVEL`                                                          | `test`, `explorer`, `basic` or `standard` (overrides what `init` saved).                               |
| `PERFOADS_MCP_KEY_BACKEND`                                                           | `file` forces the key file instead of the Keychain / keyring (headless machines, the hardened setup).  |
| `PERFOADS_MCP_CLIENT_ID`, `PERFOADS_MCP_CLIENT_SECRET`, `PERFOADS_MCP_REFRESH_TOKEN` | Weaker option instead of `init`: the sign-in in plain text in the AI app's config file. Prefer `init`. |

## Claude Desktop extension (.mcpb)

`node scripts/build-mcpb.mjs` (after `pnpm install && pnpm build`) packs a Claude Desktop extension into `dist/`. Run `init` in a terminal first: the extension has no sign-in step and uses the same settings folder (its only setting).

**Node version:** the extension declares `compatibility.runtimes.node: ">=22.13.0"` (MCPB manifest 0.4). Claude Desktop runs extensions with its built-in Node.js by default, and that Node may be older than 22.13. If the extension fails to start (or `doctor` reports an old Node), turn off the built-in Node.js for extensions in Claude Desktop's extension settings (if your version has that switch) so it uses your installed Node 22.13+, or use the JSON config above with `npx` instead.

## ChatGPT desktop and Codex

The ChatGPT desktop app, the Codex CLI and the Codex IDE extension run local (stdio) MCP servers and share one configuration, `~/.codex/config.toml`. ChatGPT on the web does not read it and needs a remote server, which this project does not offer.

Run `init` in a terminal first (step 7), then add the server one of these ways.

**ChatGPT desktop app:** Settings > MCP servers > Add server. Name `perfoads-mcp`, type STDIO, command `npx`, arguments `-y`, `perfoads-mcp@<version>`, `serve`. Save, then Restart. Type `/mcp` in the composer to see it.

**Codex CLI:**

```sh
codex mcp add perfoads-mcp -- npx -y perfoads-mcp@<version> serve
```

**Or edit `~/.codex/config.toml`** (raise the timeouts: the first `npx` download can take longer than Codex's 10-second start limit, and an audit can take up to about 4 minutes, longer than its 60-second tool limit):

```toml
[mcp_servers.perfoads-mcp]
command = "npx"
args = ["-y", "perfoads-mcp@<version>", "serve"]
startup_timeout_sec = 60
tool_timeout_sec = 300
```

Add `env = { PERFOADS_MCP_HOME = "/full/path/to/settings" }` only if you used a non-default settings folder for `init`. Not on npm yet: use the `node` command and full path that `init` prints instead of `npx`.

Codex can run shell commands, so the same rule as for Claude Code applies: the approval step only holds against the agent with the [hardened setup](HARDENED-SETUP.md).

## Updating and removing

- Update: change the exact version in your AI app config (and the commands you run); check the [changelog](../CHANGELOG.md) first.
- Sign in again: `npx perfoads-mcp@<version> auth`.
- Remove: `npx perfoads-mcp@<version> reset`, delete the settings folder, remove the app at myaccount.google.com/permissions, and delete the OAuth client in your Cloud project if you no longer need it.
