# Contributing

Thanks for helping. The project is in early alpha; expect large changes.

## Sign your commits (DCO)

Every commit must carry a Developer Certificate of Origin sign-off (https://developercertificate.org):

    Signed-off-by: Your Name <you@example.com>

Use `git commit -s` to add it.

Contributions are accepted under the project's licence, Apache-2.0 (see `LICENSE`).

## Rules for changes that write to Google Ads

Every new write type must ship with all three:

1. **Tests** - unit tests plus a recorded-fixture contract test.
2. **Undo** - a tested way to roll the change back.
3. **Read-back** - a tested check that reads the account after applying and confirms the change landed.

PRs adding a write type without all three will not be merged.

## Hygiene

- Never commit secrets, tokens, real customer ids or real client data. Use synthetic fixtures only.
- The pre-commit hook runs `scripts/hygiene-check.sh` (and gitleaks if installed). Enable it with `git config core.hooksPath .githooks`.
- Every TypeScript source file starts with the license header (`// SPDX-License-Identifier: Apache-2.0` and the copyright line); the hygiene check fails without it.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm hygiene` before opening a PR.
- `docs/TOOLS.md` and `docs/CHECKS.md` are generated: after changing a tool or a check, run `pnpm build && pnpm docs` (CI fails on a stale copy).

## Releases

Versions are managed with changesets (`pnpm changeset`). Publishing runs only in `.github/workflows/release.yml`, started by hand (a real publish from the `v<version>` tag of the CLI version), never on a push, and is blocked while the repository is private. A build job (no OIDC token) checks, tests and packs; a separate publish job (OIDC, no cache, `--ignore-scripts`) publishes those tarballs with provenance through npm trusted publishing. Before a release, set `"perfoads": {"published": true}` in `packages/cli/package.json` (then every message and config snippet says `npx perfoads-mcp@<version>`), and run `pnpm shrinkwrap` after any dependency change.

Before the first publish, the `@perfoads` npm scope (organization) and the package name `perfoads-mcp` must be reserved on npm by the maintainer, and a trusted publisher (this repository, workflow `release.yml`) added to each package on npmjs.com (an `NPM_TOKEN` secret is only a fallback; see the comment at the top of `release.yml`). Otherwise the first publish of `@perfoads/*` fails or the names can be taken.

## Code of conduct

See `CODE_OF_CONDUCT.md`.
