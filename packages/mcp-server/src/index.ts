// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

export { createMcpServer, OUTPUT_SCHEMAS, type ServerOptions } from "./server.js";
export { serveOverStdio } from "./stdio.js";
export {
  AccountNotAllowedError,
  AccountNotCheckedError,
  ADS_READ_DEADLINE_MS,
  createRuntime,
  CONFIG_FILE,
  NO_POLICY_FILE,
  readApprovalMode,
  type ApprovalSettings,
  NotSignedInError,
  RuntimeClosedError,
  TOOL_DEADLINE_MS,
  type CredentialState,
  type Runtime,
  type RuntimeOptions,
} from "./runtime.js";
export {
  checkAccessLevel,
  checkApprovalPage,
  checkClaudeHooks,
  checkElicitation,
  checkConfigDir,
  checkNode,
  checkOAuthMode,
  checkOps,
  checkPlugin,
  findAutoAnswerHooks,
  formatDoctor,
  runDoctor,
  type CheckStatus,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport,
} from "./doctor.js";
export {
  ADWORDS_SCOPE,
  createRefreshTokenProvider,
  GOOGLE_AUTH_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  OAuthError,
  postTokenRequest,
  revokeRefreshToken,
  type TokenReply,
} from "./tokens.js";
export {
  decodeCursor,
  encodeCursor,
  GAQL_DEFAULT_LIMIT,
  GAQL_MAX_LIMIT,
  guardGaql,
  type GaqlGuardResult,
} from "./gaql.js";
export { GAQL_RESOURCES } from "./gaqlResources.js";
export {
  ENUM_FIELDS,
  UNTRUSTED_NOTE,
  untrusted,
  wrapUntrusted,
  type Untrusted,
} from "./untrusted.js";
export {
  DEFAULT_READ_TIMING,
  READ_OUTPUT_SCHEMAS,
  registerReadTools,
  type ReadTiming,
} from "./readTools.js";
export { errorText } from "./toolKit.js";
export {
  APPLY_CALL_BUDGET_MS,
  APPROVAL_WAIT_MS,
  DEFAULT_CHANGE_TIMING,
  registerChangeTools,
  statusText,
  type ChangeToolTiming,
} from "./changeTools.js";
export {
  CODE_ALPHABET,
  CODE_LENGTH,
  localUser,
  MAX_CODE_ATTEMPTS,
  openSessionFor,
  SESSION_LIFETIME_MS,
  type ApprovalSession,
  type CodeCheck,
  type SessionKind,
} from "./approvals/sessions.js";
export {
  approvalSummaryText,
  dashedId,
  escapeHtml,
  OUTCOME_WORDS,
  stripBidi,
} from "./approvals/view.js";
export { canBindPage, openerCommand, openLocalPage, type ApprovalPage } from "./approvals/page.js";
export {
  approvalsOpenNeeded,
  browserOpenFailed,
  createApprovalService,
  type ApprovalMode,
  type ApprovalService,
  type ApprovalState,
} from "./approvals/service.js";
export {
  loadedPlugin,
  loadPlugin,
  NO_PLUGIN,
  PLUGIN_CONFIG_KEY,
  PLUGIN_LOAD_MS,
  readPluginSetting,
  validatePlugin,
  type Importer,
  type PluginPrompt,
  type PluginState,
  type PluginTool,
  type ServerPlugin,
} from "./plugin.js";
export { PRODUCT_NAME, SERVER_NAME, SERVER_VERSION, WORK_WITH_NOTE } from "./version.js";
