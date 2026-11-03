// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/** Google's ad types (ad_group_ad.ad.type) in plain words; the ad's name in the model. */
export const AD_TYPE_WORDS: Readonly<Record<string, string>> = {
  DEMAND_GEN_MULTI_ASSET_AD: "photo ad",
  DISCOVERY_MULTI_ASSET_AD: "photo ad",
  DEMAND_GEN_VIDEO_RESPONSIVE_AD: "video ad",
  DISCOVERY_VIDEO_RESPONSIVE_AD: "video ad",
  DEMAND_GEN_CAROUSEL_AD: "carousel ad",
  DISCOVERY_CAROUSEL_AD: "carousel ad",
  DEMAND_GEN_PRODUCT_AD: "product ad",
  RESPONSIVE_SEARCH_AD: "responsive search ad",
  EXPANDED_TEXT_AD: "text ad",
  TEXT_AD: "text ad",
  EXPANDED_DYNAMIC_SEARCH_AD: "dynamic search ad",
  CALL_AD: "call ad",
  RESPONSIVE_DISPLAY_AD: "responsive display ad",
  LEGACY_RESPONSIVE_DISPLAY_AD: "responsive display ad",
  IMAGE_AD: "image ad",
  HTML5_UPLOAD_AD: "uploaded display ad",
  DYNAMIC_HTML5_AD: "dynamic display ad",
  VIDEO_AD: "video ad",
  VIDEO_RESPONSIVE_AD: "video ad",
  IN_FEED_VIDEO_AD: "in-feed video ad",
  VIDEO_BUMPER_AD: "bumper video ad",
  VIDEO_NON_SKIPPABLE_IN_STREAM_AD: "non-skippable video ad",
  VIDEO_TRUEVIEW_IN_STREAM_AD: "skippable video ad",
  VIDEO_OUTSTREAM_AD: "outstream video ad",
  YOUTUBE_AUDIO_AD: "audio ad",
  SHOPPING_PRODUCT_AD: "shopping ad",
  SHOPPING_SMART_AD: "smart shopping ad",
  SHOPPING_COMPARISON_LISTING_AD: "comparison shopping ad",
  APP_AD: "app ad",
  LEGACY_APP_INSTALL_AD: "app ad",
  APP_ENGAGEMENT_AD: "app ad",
  APP_PRE_REGISTRATION_AD: "app ad",
  HOTEL_AD: "hotel ad",
  TRAVEL_AD: "travel ad",
  LOCAL_AD: "local ad",
  SMART_CAMPAIGN_AD: "smart campaign ad",
};

/** An ad type in plain words; unknown, empty or UNSPECIFIED = "ad". */
export function adTypeWords(type: string | null | undefined): string {
  return (
    AD_TYPE_WORDS[
      String(type ?? "")
        .trim()
        .toUpperCase()
    ] ?? "ad"
  );
}
