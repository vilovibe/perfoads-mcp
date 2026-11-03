# Claude Code

**Not on npm yet:** until the first release, install from source (main README) and replace `npx -y perfoads-mcp@<version>` below with the full Node path and `<full path>/packages/cli/bin/perfoads-mcp.js` (`init` prints the exact command).

Run `init` once in a terminal first (sign-in, starter policy).

Add the server for your user (all projects):

```sh
claude mcp add --scope user perfoads-mcp -- npx -y perfoads-mcp@<version> serve
```

Only for the current project, leave out `--scope user`. With a custom settings folder (the same one you used for `init`):

```sh
claude mcp add --scope user perfoads-mcp -e PERFOADS_MCP_HOME="$HOME/perfoads-mcp-settings" -- npx -y perfoads-mcp@<version> serve
```

Check it: `claude mcp list`, then ask Claude to "run doctor".

## Before allowing changes

Claude Code has a shell on your user account. The approval code protects you from a confused AI, not from one that sets out to get around it: an AI with a shell can read the store, edit the policy and fake a terminal. Before you list any live account under `accounts.write`:

- use the [hardened setup](../docs/HARDENED-SETUP.md) (the server under a separate OS user or in a container) and set `approval_mode` to `code_only`;
- don't add hooks that answer MCP forms (elicitations) automatically - `doctor` warns about the ones it can see;
- keep the settings folder outside every project folder (`doctor` checks).

The hardened variant of the command above starts the server through `sudo` or `ssh` as the service user; see the recipes there.
