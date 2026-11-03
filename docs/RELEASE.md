# Release

How a version goes out: npm first, then the official MCP Registry, then the GitHub release with the Claude Desktop extension (`.mcpb`), then the Claude plugin. The registry stores metadata only, so the npm package must exist before `mcp-publisher publish`.

Names (see [NAMING.md](NAMING.md)): npm `perfoads-mcp` (CLI) and `@perfoads/*` (libraries); registry `com.perfoads/mcp`; Claude plugin `perfoads` in the marketplace `perfoads` (this repository).

## 0. Once, before the first release

- **Pick the registry namespace for good.** `com.perfoads/mcp` (DNS proof on perfoads.com, section 3) or the fallback `io.github.vilovibe/perfoads-mcp` (GitHub login, section 3b). The name is permanent, and `mcpName` is inside the published npm `package.json`: switching later needs a new npm version.
- **npm:** create the free npm organization `perfoads` (for `@perfoads/*`), and make sure `perfoads-mcp` is still free (`npm view perfoads-mcp` gives E404). Then, on npmjs.com, add a trusted publisher to every package (this repository, workflow `release.yml`); see the comment at the top of `.github/workflows/release.yml`.
- **Repository public.** `release.yml` refuses to publish from a private repository.
- **Privacy page.** The PerfoAds MCP section is live on https://perfoads.com/privacypolicy (the `.mcpb`, the Claude plugin and the README link there).
- **Contact.** Support, security and privacy contact is contact@perfoads.com: `SECURITY.md`, the Claude plugin and marketplace (`author.email`, `owner.email`), the `.mcpb` manifest (`author.email`) and the READMEs. Keep that mailbox monitored; bugs go to GitHub issues.
- **Plugin icon.** `claude-plugin/.claude-plugin/icon.png` (1024 px, also packed into the `.mcpb`) is in place before the plugin is first saved in Claude's developer portal: the portal takes the icon only once.

## 1. Bump the version everywhere

1. `pnpm changeset` and `pnpm changeset version` (all packages move together).
2. Put the new CLI version in `server.json` (`version` and `packages[0].version`), `claude-plugin/.claude-plugin/plugin.json` (`version` and the `perfoads-mcp@<version>` launcher argument) and every `perfoads-mcp@<version>` in `claude-plugin/README.md`. Exact versions only, never a range or `latest`.
3. For the first real publish set `"perfoads": {"published": true}` in `packages/cli/package.json` (messages then say `npx perfoads-mcp@<version>`).
4. Run the gate: `pnpm install && pnpm -r typecheck && pnpm lint && pnpm test && pnpm hygiene && pnpm docs:check`. `docs:check` fails if a listing file names another version.
5. Commit, then tag: `git tag v<version> && git push origin v<version>`.

## 2. npm

GitHub > Actions > release > Run workflow, from the tag `v<version>`: first with "Dry run" on, then off. It packs and publishes every package (dependencies first) with provenance; a prerelease version is published under its own dist-tag (`0.1.0-alpha.0` goes to `alpha`, not `latest`).

Check: `npm view perfoads-mcp@<version> mcpName` prints `com.perfoads/mcp`.

## 3. Official MCP Registry (`com.perfoads/mcp`)

Install the publisher: `brew install mcp-publisher`, or the `mcp-publisher_<os>_<arch>.tar.gz` from https://github.com/modelcontextprotocol/registry/releases. Check the file: `mcp-publisher validate` (in the repository root, it reads `./server.json`).

**DNS proof, once per key.** You need OpenSSL 3 (macOS's own `openssl` is LibreSSL and can't make Ed25519 keys: `brew install openssl@3`, then use `/opt/homebrew/opt/openssl@3/bin/openssl`). Work in a folder outside this repository and keep `key.pem` in your password manager (or as a GitHub Actions secret later), never in a repository.

```sh
OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
$OPENSSL genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$($OPENSSL pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}"
```

Add the printed value as a **TXT record on the apex** of perfoads.com (Namecheap: Domain List > perfoads.com > Advanced DNS > Add new record > TXT Record, Host `@`, Value `v=MCPv1; k=ed25519; p=<PUBLIC_KEY>`). Not on a subdomain such as `_mcp-auth`: the registry reads only the apex. It sits next to the existing TXT records. When you change keys, delete the old record, or verification fails. Wait until `dig +short TXT perfoads.com` shows it.

Done on 25 Oct 2026: the TXT record is live on perfoads.com, and the private key (hex) is in the maintainer's macOS Keychain, service `perfoads-mcp-registry-key`, account `perfoads.com` (no `key.pem` kept). On that Mac, read it with `security find-generic-password -a perfoads.com -s perfoads-mcp-registry-key -w` instead of the first line below.

```sh
PRIVATE_KEY="$($OPENSSL pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --domain perfoads.com --private-key "${PRIVATE_KEY}"
mcp-publisher publish
```

Check: https://registry.modelcontextprotocol.io/v0.1/servers?search=com.perfoads/mcp

Each version can be published once and never changed; a fix is a new version. To hide a version: `mcp-publisher status` (marks it deleted; metadata is never removed).

`websiteUrl` in `server.json` points to the PerfoAds home page; switch it to `https://perfoads.com/mcp?utm_source=mcp-registry` once that page exists.

### 3b. Fallback: `io.github.vilovibe/perfoads-mcp`

No DNS needed. Before the npm publish of that version, set `"mcpName": "io.github.vilovibe/perfoads-mcp"` in `packages/cli/package.json` and `"name"` in `server.json` to the same value, then after npm:

```sh
mcp-publisher login github
mcp-publisher publish
```

## 4. GitHub release with the `.mcpb`

```sh
node scripts/build-mcpb.mjs          # writes dist/perfoads-mcp-<version>.mcpb and validates its manifest
gh release create v<version> dist/perfoads-mcp-<version>.mcpb \
  --title "PerfoAds MCP <version>" --notes-file <notes.md> --prerelease   # drop --prerelease for a stable version
```

Notes: the version's CHANGELOG section. Claude Desktop users install the `.mcpb` from the release page (double-click, or Settings > Extensions > Advanced settings > Install Extension), after running `init` once.

## 5. Claude plugin

- **Own marketplace (works as soon as npm and the public repository are live):** users run `/plugin install perfoads --marketplace vilovibe/perfoads-mcp`. Check locally first: `claude plugin validate .` and `claude plugin validate ./claude-plugin --strict`.
- **Claude plugin directory:** https://claude.ai/directory/manage > Submit new > Plugin bundle, repository `vilovibe/perfoads-mcp`, plugin folder `claude-plugin`, then Validate. The pinned `npx` launcher is always held for a reviewer ("Runs a pinned npx or uvx package"); that is expected. Every new version needs a raised `version` in `plugin.json`.
