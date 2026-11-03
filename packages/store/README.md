# @perfoads/store

Local storage on Node's built-in SQLite (`node:sqlite`, WAL mode), in the per-user settings folder.

- Versioned migrations (`src/migrations.ts`), each applied once inside `BEGIN IMMEDIATE`. Tables: `meta`, `accounts`, `credentials` (v1); `changes`, `audit_log`, `ops_usage` (v2). Triggers enforce the change state machine, keep approved fields fixed, never delete changes, and make `audit_log` append-only. Snapshots come later.
- `createStoreOpsCounter`: Google Ads operations over a rolling 24 hours in `ops_usage`, shared by every process on the store. `approvalHmacKey`: the random key that signs approval request state, made once per store.
- Credentials (OAuth client id, client secret, refresh token) are encrypted with AES-256-GCM: a fresh 96-bit IV per value, the purpose bound as additional data.
- The data key lives in the macOS Keychain, the Linux keyring (`secret-tool`), or an owner-only key file. `PERFOADS_MCP_KEY_BACKEND=file` forces the key file.
