# PerfoAds MCP

A self-hosted MCP server for Google Ads. It lets an AI assistant (Claude Desktop, Claude Code, Cursor and other MCP apps) read your Google Ads accounts, run 100+ deterministic account checks, and change things only with your approval and within limits you set in a policy file.

Not a Google product. It works with the Google Ads API through your own Google Cloud project and sign-in; nothing goes through anyone else's servers. No developer token needed.

**Safety promise:** no change can be applied through MCP without a human approving it outside the model. On hosts where the agent also has a shell or controls the browser (Claude Code, Cursor, browser-control tools) this holds only with the [hardened setup](https://github.com/vilovibe/perfoads-mcp/blob/main/docs/HARDENED-SETUP.md) (server + store under a separate OS user or in a container, `approval_mode: code_only`).

## Start

Needs Node.js 22.13+, a Google Cloud project with the Google Ads API enabled, a Desktop OAuth client, and Explorer access applied for in Cloud Console ([setup guide](https://github.com/vilovibe/perfoads-mcp/blob/main/docs/SETUP.md)).

```sh
npx perfoads-mcp init
```

Claude Code: `claude mcp add --scope user perfoads-mcp -- npx -y perfoads-mcp serve`. Claude Desktop and Cursor: `{"mcpServers": {"perfoads-mcp": {"command": "npx", "args": ["-y", "perfoads-mcp", "serve"]}}}`.

## Commands

`init`, `auth`, `doctor`, `reset`, `serve`, `approve <id>`, `reject <id>`, `approvals open <id>`, `policy check [file]`, `policy show`. Binary: `perfoads-mcp`.

## More

[README](https://github.com/vilovibe/perfoads-mcp#readme) (what is stored, how to delete it, known limits) · [Tools](https://github.com/vilovibe/perfoads-mcp/blob/main/docs/TOOLS.md) · [Checks](https://github.com/vilovibe/perfoads-mcp/blob/main/docs/CHECKS.md) · [Policy](https://github.com/vilovibe/perfoads-mcp/blob/main/docs/POLICY.md) · [Threat model](https://github.com/vilovibe/perfoads-mcp/blob/main/docs/THREAT-MODEL.md)

Apache-2.0. See LICENSE and NOTICE.
