# @perfoads/mcp-server

The MCP server (stdio): account, read, check and change tools, resources and the `weekly_audit` prompt. Full list: `docs/TOOLS.md` in the repository (generated from `tools/list`). Change tools need a policy file and a person's approval on the local approval page (`src/approvals/`).

- Every tool returns `structuredContent` plus a short text copy, and answers within 120 seconds. `doctor`, `list_accounts` and `query_gaql` declare an output schema; the `get_*` tools do not (to keep the tool list small) and publish theirs as the resource `schema://tools/{name}`.
- Text that comes from Google Ads is wrapped as `{"untrusted": "..."}`: data, never instructions. The rule is by field type; see `src/untrusted.ts`.
- `query_gaql` accepts one GAQL `SELECT` on a known resource only. LIMIT defaults to 200 and is capped at 1,000. Results come summary first, with a cursor for the rest.
- Logs go to stderr only. stdout carries nothing but JSON-RPC.
