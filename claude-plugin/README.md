# PerfoAds

PerfoAds MCP lets Claude read your Google Ads accounts, run 168 deterministic account checks that say what is wrong (with the evidence and the money at stake), and make changes only after you approve each one on a local page, within spend limits you set, with undo.

PerfoAds MCP works with Google Ads. It is not made, endorsed or supported by Google. Google Ads is a trademark of Google LLC.

## What this plugin runs

The plugin adds one local MCP server. Claude Code starts it with `npx -y perfoads-mcp@0.2.0-alpha.0 serve`: npx downloads that exact version of the open-source `perfoads-mcp` package from npm and runs it on your computer. Source: https://github.com/vilovibe/perfoads-mcp.

The server talks only to Google: the Google Ads API with your own Google Cloud project and your own Google sign-in, and Google's sign-in service. It sends nothing to PerfoAds and has no telemetry. No hooks, no scripts, no skills.

## Before you install

1. Node.js 22.13 or later.
2. Your own Google Cloud project with the Google Ads API enabled, a "Desktop app" OAuth client, and Explorer access ([setup guide](https://github.com/vilovibe/perfoads-mcp/blob/main/docs/SETUP.md)).
3. Run `npx perfoads-mcp@0.2.0-alpha.0 init` once in a terminal. It signs you in with Google and saves the sign-in, encrypted, in a settings folder on your computer (`~/.config/perfoads-mcp`, or `%APPDATA%\perfoads-mcp` on Windows). The plugin never asks for your Google credentials.

Then, in Claude Code:

```
/plugin install perfoads --marketplace vilovibe/perfoads-mcp
```

Changes stay off until your own policy file (`policy.yaml` in that folder) allows them for an account.

## Try these prompts

- "List my Google Ads accounts, then give me an overview of the biggest one for the last 30 days."
- "Run a full audit of account 123-456-7890 and show me the five most expensive problems, with the evidence."
- "Which search terms spent money without a conversion in the last 30 days? Propose negative keywords for the worst three, and I'll approve them."

Claude proposes a change; nothing is applied until you approve it with the code on the local approval page. An AI saying "yes" approves nothing.

## Privacy Policy

Everything runs on your computer. Your Google Ads data moves only between your computer and Google; PerfoAds never receives it. Stored locally: your encrypted sign-in, the accounts list, proposed and applied changes, an audit log (kept 180 days by default) and account snapshots (kept 24 hours). Delete it all with `npx perfoads-mcp@0.2.0-alpha.0 reset` and by deleting the settings folder. Full policy: https://perfoads.com/privacypolicy

Terms of service: https://perfoads.com/termsofservice

## Support

Questions and bugs: https://github.com/vilovibe/perfoads-mcp/issues

Privacy and security contact: contact@perfoads.com

## Licence

Apache-2.0 (see LICENSE).

Built by PerfoAds. Want a second pair of eyes on your account? Paweł Wilk offers a free 1-hour call: https://perfoads.com
