// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

export { createAdsClient, type AdsClient } from "./client.js";
export {
  createTransport,
  normalizeCustomerId,
  DEFAULT_RETRY_POLICY,
  DEFAULT_READ_DEADLINE_MS,
  DEFAULT_TIMEOUT_MS,
  type AdsClientConfig,
  type AdsRequest,
  type AdsResponse,
  type RetryPolicy,
  type Transport,
} from "./transport.js";
export { GOOGLE_ADS_API_VERSION, GOOGLE_ADS_API_HOST } from "./version.js";
export {
  MERCHANT_API_HOST,
  MERCHANT_MAX_PRODUCTS,
  MERCHANT_SCOPE,
  assertMerchantId,
  createMerchantClient,
  merchantAccessProblem,
  type DataSourceRef,
  type LabelTarget,
  type MerchantAccessProblem,
  type MerchantClient,
  type MerchantDataSource,
  type MerchantProduct,
} from "./merchant.js";
export type {
  AccessLevel,
  FetchFn,
  Logger,
  OpsCounter,
  OpsKind,
  OpsPool,
  TokenProvider,
} from "./types.js";
export {
  AdsDailyLimitError,
  AdsInDoubtError,
  AdsNetworkError,
  AdsNotSentError,
  BUSY_ERROR_CODES,
  GoogleAdsBusyError,
  AdsNotAllowedError,
  GoogleAdsApiError,
  classifyAccessError,
  hasErrorCode,
  dailyLimitLine,
  dailyLimitOf,
  humanWait,
  isDailyQuotaExhausted,
  isProjectDailyLimit,
  type AccessIssue,
  parseGoogleFailure,
  plainEnglish,
  type GoogleAdsErrorDetail,
  type ParsedGoogleFailure,
} from "./errors.js";
export {
  createTempIds,
  tempResourceName,
  type MutateResult,
  type OperationResult,
  type RemoveOutcome,
  type RemoveResult,
  type ResponseContentType,
  type WriteOptions,
} from "./mutate.js";
export type { SearchAllResult, SearchPage, SearchParams } from "./search.js";
export type { AdsAccount, DiscoverFailure, DiscoverResult } from "./accounts.js";
export type { KeywordIdea, KeywordIdeasPage, KeywordIdeasParams } from "./keywordPlanner.js";
export type { FieldSearchPage, FieldSearchParams } from "./fields.js";
export {
  CURRENCY_MINIMUM_UNIT_MICROS,
  MICROS_PER_UNIT,
  decimalToMicros,
  microsToDecimalString,
  minimumUnitMicros,
  parseMicros,
  roundMicrosToCurrency,
  type RoundingMode,
} from "./money.js";
export {
  DAILY_OPS_LIMITS,
  DEFAULT_DAILY_OPS_BUDGET,
  createMemoryOpsCounter,
  type OpsLimits,
} from "./opsCounter.js";
export {
  createRedactingLogger,
  createStderrLogger,
  noopLogger,
  redactString,
  redactValue,
} from "./logger.js";
