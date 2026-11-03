# Examples

- [claude-desktop.json](claude-desktop.json) - Claude Desktop: Settings > Developer > Edit Config (`claude_desktop_config.json`). Merge the `mcpServers` entry into your file.
- [claude-code.md](claude-code.md) - Claude Code: the `claude mcp add` command.
- [cursor.json](cursor.json) - Cursor: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in one project.
- [policy.example.yaml](policy.example.yaml) - a read-only starter policy with a commented example for changes on a test account. Copy it to the settings folder as `policy.yaml`.

**Not on npm yet:** these snippets use `npx perfoads-mcp@<version>` (always the exact version), which works only after the first npm release. Until then install from source (see the main README) and use the config `init` prints: `"command": "<full path to node>"` with `"args": ["<full path>/packages/cli/bin/perfoads-mcp.js", "serve"]`.

Run `init` first: it signs you in and prints these snippets for your machine. Restart the AI app after changing its config.
