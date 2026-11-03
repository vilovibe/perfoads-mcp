// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

export {
  MAX_TEXT_CHARS,
  UNTRUSTED_NOTE,
  UntrustedSchema,
  untrusted,
  untrustedOrNull,
  untrustedText,
  type Untrusted,
} from "./untrusted.js";
export * as normalise from "./normalise.js";
export type { Metrics, Totals } from "./normalise.js";
export {
  DATE_PRESETS,
  DEFAULT_PRESET,
  DateRangeInputSchema,
  DateRangeSchema,
  MAX_RANGE_DAYS,
  ReadInputError,
  dateCondition,
  describeDateRange,
  resolveDateRange,
  type DatePreset,
  type DateRange,
  type DateRangeInput,
} from "./dateRange.js";
export {
  DEFAULT_PAGE_BYTES,
  DEFAULT_PAGE_ROWS,
  MIN_PART_MS,
  partOk,
  DEFAULT_READ_CAP,
  MAX_PAGE_ROWS,
  decodeReaderCursor,
  defaultDescribeError,
  encodeReaderCursor,
  readNothing,
  runReader,
  statusOfError,
  type PageOptions,
  type Part,
  type PartStatus,
  type PartsData,
  type ReaderContext,
  type ReaderDef,
  type ReaderResult,
  type ReaderStatus,
  type SearchFn,
} from "./reader.js";
export {
  MetricsSchema,
  STATUS_FILTERS,
  TEST_ACCOUNT_STATUS_NOTE,
  TotalsSchema,
  checkId,
  filterConditions,
  filterInput,
  testAccountStatusNote,
  type FilterInput,
} from "./common.js";
export {
  CampaignRowSchema,
  CampaignSummarySchema,
  campaignsReader,
  type CampaignRow,
  type CampaignsInput,
  type CampaignsRecent,
} from "./readers/campaigns.js";
export {
  AdGroupRowSchema,
  AdGroupSummarySchema,
  adGroupsReader,
  type AdGroupRow,
} from "./readers/adGroups.js";
export {
  KeywordRowSchema,
  KeywordSummarySchema,
  keywordsReader,
  type KeywordRow,
} from "./readers/keywords.js";
export {
  PMAX_CATEGORIES_SHOWN,
  PMAX_TERMS_PER_CAMPAIGN,
  NO_CATEGORY_LABEL,
  PmaxCategorySchema,
  SearchTermRowSchema,
  SearchTermSummarySchema,
  TermMetricsSchema,
  searchTermsReader,
  type SearchTermInput,
  type SearchTermRow,
} from "./readers/searchTerms.js";
export {
  BudgetRowSchema,
  BudgetSummarySchema,
  StrategySchema,
  budgetsReader,
  type BudgetRow,
} from "./readers/budgets.js";
export {
  NegativeRowSchema,
  NegativeSummarySchema,
  SharedListSchema,
  negativesReader,
  type NegativeRow,
} from "./readers/negatives.js";
export {
  ChannelRowSchema,
  OverviewSummarySchema,
  overviewReader,
  type OverviewInput,
} from "./readers/overview.js";
export {
  ADS_ASSETS_KINDS,
  AdAssetRowSchema,
  AdDetailSchema,
  AdsAssetsSummarySchema,
  AssetDetailSchema,
  adsAssetsInput,
  adsAssetsReader,
  type AdAssetRow,
  type AdsAssetsInput,
} from "./readers/adsAssets.js";
export {
  AUDIENCE_KINDS,
  AudienceRowSchema,
  AudienceSummarySchema,
  UserListDetailSchema,
  audiencesInput,
  audiencesReader,
  type AudienceRow,
  type AudiencesInput,
} from "./readers/audiences.js";
export {
  ConversionActionRowSchema,
  ConversionMetricsSchema,
  ConversionSummarySchema,
  GoalSchema,
  conversionsReader,
  type ConversionActionRow,
  type ConversionDetail,
  type ConversionsInput,
} from "./readers/conversions.js";
export {
  CHANGE_RESOURCE_TYPES,
  ChangeRowSchema,
  ChangeSummarySchema,
  DEFAULT_CHANGE_DAYS,
  MAX_CHANGE_DAYS,
  changeHistoryInput,
  changeHistoryReader,
  maskEmail,
  type ChangeHistoryInput,
  type ChangeRow,
} from "./readers/changeHistory.js";
export {
  DEFAULT_IDEAS,
  KeywordIdeaRowSchema,
  LANGUAGE_IDS,
  MAX_IDEAS,
  compareIdeas,
  keywordIdeaRow,
  keywordIdeasInput,
  type KeywordIdeaRow,
  type KeywordIdeasInput,
} from "./keywordIdeas.js";
// Internal readers: no MCP tool, used by the account snapshot (P3b).
export {
  BidModifierRowSchema,
  BidModifierSummarySchema,
  bidModifiersReader,
  type BidModifierRow,
} from "./readers/bidModifiers.js";
export {
  BiddingAdjustmentRowSchema,
  BiddingAdjustmentSummarySchema,
  biddingAdjustmentsReader,
  type BiddingAdjustmentRow,
} from "./readers/biddingAdjustments.js";
export {
  ExperimentRowSchema,
  ExperimentSummarySchema,
  experimentsReader,
  type ExperimentRow,
} from "./readers/experiments.js";
export {
  AccountExclusionRowSchema,
  AccountExclusionSummarySchema,
  accountExclusionsReader,
  type AccountExclusionRow,
} from "./readers/accountExclusions.js";
export {
  LandingPageRowSchema,
  LandingPageSummarySchema,
  landingPagesReader,
  type LandingPageCampaignClicks,
  type LandingPageRow,
  type LandingPagesInput,
} from "./readers/landingPages.js";
export {
  CampaignSettingsRowSchema,
  CampaignSettingsSummarySchema,
  campaignSettingsReader,
  type CampaignSettingsRow,
} from "./readers/campaignSettings.js";
export {
  AutoApplyRowSchema,
  AutoApplySummarySchema,
  UserAccessRowSchema,
  UserAccessSummarySchema,
  autoApplyReader,
  userAccessReader,
  type AutoApplyRow,
  type UserAccessRow,
} from "./readers/accountAccess.js";
export {
  CAMPAIGN_DAILY_CAP,
  DailyMetricRowSchema,
  DailyMetricSummarySchema,
  dailyMetricsReader,
  type DailyMetricRow,
} from "./readers/dailyMetrics.js";
export {
  SCHEDULE_GRID_CAP,
  SlicePerformanceRowSchema,
  SlicePerformanceSummarySchema,
  slicePerformanceReader,
  type SlicePerformanceRow,
} from "./readers/slicePerformance.js";
export {
  OFFLINE_JOBS_CAP,
  OfflineJobRowSchema,
  OfflineJobSummarySchema,
  offlineJobsReader,
  type OfflineJobRow,
} from "./readers/offlineJobs.js";
export {
  DsaSearchTermRowSchema,
  DsaSearchTermSummarySchema,
  dsaSearchTermsReader,
  type DsaSearchTermRow,
} from "./readers/dsaSearchTerms.js";
export {
  POINTS_KEPT,
  SimulationRowSchema,
  SimulationSummarySchema,
  simulationsReader,
  type SimulationRow,
} from "./readers/simulations.js";
export {
  PLACEMENTS_PER_CAMPAIGN,
  PLACEMENT_CAMPAIGNS_DEFAULT,
  PLACEMENT_CAMPAIGNS_MAX,
  PmaxExtraSchema,
  type PmaxExtra,
  type PmaxInput,
  PMAX_ROW_KINDS,
  PmaxRowSchema,
  PmaxSummarySchema,
  pmaxReader,
  type PmaxRow,
} from "./readers/pmax.js";
export {
  CampaignControlRowSchema,
  CampaignControlSummarySchema,
  campaignControlsReader,
  type CampaignControlRow,
} from "./readers/campaignControls.js";
export {
  SEGMENT_CAP,
  SegmentRowSchema,
  SegmentSummarySchema,
  segmentPerformanceReader,
  type SegmentRow,
} from "./readers/segmentPerformance.js";
export {
  PriorYearDayRowSchema,
  PriorYearSummarySchema,
  priorYearDailyReader,
  type PriorYearDayRow,
} from "./readers/priorYearDaily.js";
export {
  CAMPAIGN_PRODUCT_CAP,
  SHOPPING_PRODUCT_CAP,
  SHOPPING_ROW_KINDS,
  ShoppingExtraSchema,
  ShoppingRowSchema,
  ShoppingSummarySchema,
  shoppingReader,
  type ShoppingExtra,
  type ShoppingRow,
} from "./readers/shopping.js";
export {
  PLACEMENT_CAP,
  PlacementRowSchema,
  PlacementSummarySchema,
  placementsReader,
  type PlacementRow,
} from "./readers/placements.js";
export {
  COUNTRY_ROW_CAP,
  GEO_LANGUAGE_ROW_KINDS,
  GeoLanguageRowSchema,
  GeoLanguageSummarySchema,
  geoLanguagesReader,
  type GeoLanguageRow,
} from "./readers/geoLanguages.js";
export { VideoRowSchema, VideoSummarySchema, videoReader, type VideoRow } from "./readers/video.js";
export {
  LSA_CONVERSATION_CAP,
  LSA_LEAD_CAP,
  LSA_ROW_KINDS,
  LsaRowSchema,
  LsaSummarySchema,
  localServicesReader,
  type LsaRow,
} from "./readers/localServices.js";
export {
  DG_ROW_KINDS,
  DemandGenRowSchema,
  DemandGenSummarySchema,
  demandGenReader,
  type DemandGenRow,
} from "./readers/demandGen.js";
