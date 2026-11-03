# Naming

Product name: **PerfoAds MCP** (approved 25 Oct 2026). It works with Google Ads; "Google" is in no product, package, repository or bin name. npm package and CLI: `perfoads-mcp` (one bin, no alias); inner packages `@perfoads/*`. GitHub repository: `vilovibe/perfoads-mcp`. MCP Registry name: `com.perfoads/mcp` (fallback `io.github.vilovibe/perfoads-mcp`, see [RELEASE.md](RELEASE.md)). Claude plugin: `perfoads` ("PerfoAds"), in `claude-plugin/`.

## Google's brand rule

Google's brand guidelines do not allow "Google" (or "Google Ads") as part of a third-party product name, and no Google logos. Describe the link in plain text: "works with Google Ads" in titles and taglines, "for Google Ads accounts" only inside running text. Never imply an endorsement or partnership.

Wherever the name appears we say "Not a Google product." The NOTICE file says: "Not made, endorsed or supported by Google. Google Ads is a trademark of Google LLC."

## If the product is renamed

One code constant holds the display name:

- `packages/store/src/paths.ts` - `PRODUCT_NAME` (approval page header, CLI help and `init` header, OAuth result page title, MCP `serverInfo.title`, the server's first line of instructions, the first line of the starter `policy.yaml` that `init` writes, the `.mcpb` display name, the header of the generated `docs/TOOLS.md`). It lives in the store package because every package that shows it depends on it; `@perfoads/mcp-server` re-exports it.

Then, by hand:

- `README.md` - title and first lines; `packages/*/README.md` titles where they name the product.
- `examples/policy.example.yaml` first line.
- `NOTICE` (root and the copies in `packages/*/NOTICE`), and the copyright line "Paweł Wilk" in every source file header.
- `packages/*/package.json` - `description` fields.
- `scripts/build-mcpb.mjs` - description, author name.
- `CHANGELOG.md`, `SECURITY.md`, `docs/*.md` where they name the product.
- `server.json` (`title`, `description`), `claude-plugin/.claude-plugin/plugin.json` (`displayName`, `description`), `claude-plugin/README.md`, `.claude-plugin/marketplace.json`.

If the **package / CLI name** changes too (`perfoads-mcp`), also:

- `packages/mcp-server/src/version.ts` - `SERVER_NAME` (MCP server id, `.mcpb` name, config key in printed snippets).
- `packages/cli/package.json` - `name`, `bin`; `packages/cli/bin/` file name.
- `PACKAGE_NAME` in packages/store/src/invocation.ts (every CLI and server hint goes through `howToRun`), and the `npx perfoads-mcp@<version> ...` lines in docs and examples.
- `.github/workflows/release.yml`, `.changeset/config.json`, repository URLs in every `package.json` and in `scripts/build-mcpb.mjs`.
- `mcpName` in `packages/cli/package.json` and `name` + `packages[0].identifier` in `server.json` (a registry name is permanent: publish under a new name and mark the old one deprecated); the `npx` line in `claude-plugin/.claude-plugin/plugin.json`; the private pro repository's references to the CLI package.

Keep unchanged unless you plan a migration: the settings folder name `perfoads-mcp` (`packages/store/src/paths.ts`), the Keychain / keyring service name and label (`packages/store/src/keyStore.ts`) and the encryption context string (`packages/store/src/crypto.ts`). Changing them makes existing users' saved sign-ins unreadable.

Kept on purpose in the 25 Oct 2026 rename: the Keychain service `perfoads-mcp` and label "PerfoAds MCP data key" already carried no "Google", so existing sign-ins (including the maintainer's own) keep working with no migration.
