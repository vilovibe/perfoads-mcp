// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * Google Ads API version used by every request in this package.
 * This is the only place the version is set; bump it here and nowhere else.
 */
export const GOOGLE_ADS_API_VERSION = "v26";

export const GOOGLE_ADS_API_HOST = "https://googleads.googleapis.com";

export const apiUrl = (path: string): string =>
  `${GOOGLE_ADS_API_HOST}/${GOOGLE_ADS_API_VERSION}/${path}`;
