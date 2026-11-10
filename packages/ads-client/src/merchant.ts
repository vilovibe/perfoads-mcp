// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Merchant Center (Merchant API v1) on the same sign-in, transport, error mapping and
// redacting logger as the Google Ads client. Reads: data sources and products (their
// custom labels as Google shows them). Writes: one field (custom_label_N) of a product's
// input in ONE supplemental source PerfoAds made itself, and that source when missing.
// Ported from the PerfoAds app's Merchant API v1 write path (productInputs PATCH with a
// one-field mask, 404 = insert; a field clear = the mask with no value).

import { GoogleAdsApiError } from "./errors.js";
import { asArray, asObject, asString, type JsonObject } from "./json.js";
import { createTransport, type AdsClientConfig, type Transport } from "./transport.js";

export const MERCHANT_API_HOST = "https://merchantapi.googleapis.com";
/** The OAuth scope Merchant Center needs (opt-in: `auth --merchant-center`). */
export const MERCHANT_SCOPE = "https://www.googleapis.com/auth/content";

/** Products read per page (the Merchant API maximum). */
const PAGE_SIZE = 1000;
/** Default cap on one product listing (50 pages). Past it the listing is marked capped. */
export const MERCHANT_MAX_PRODUCTS = 50_000;

const MERCHANT_ID = /^\d{1,20}$/;
const SOURCE_NAME = /^accounts\/(\d{1,20})\/dataSources\/(\d{1,20})$/;

/** Merchant Center account ids: digits only (safe inside paths). */
export const assertMerchantId = (id: string): string => {
  if (!MERCHANT_ID.test(id)) throw new TypeError(`not a Merchant Center id: "${id}"`);
  return id;
};

export interface MerchantProduct {
  /** accounts/{m}/products/{restId} */
  name: string;
  /** The product's id segment ("en~US~sku", or Google's encoded form), used for its input. */
  restId: string;
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  /** customLabel0..4 as Google shows them now (every source together); null = none. */
  labels: (string | null)[];
  /** "Mugs > Women" -> ["mugs", "women"] (lowercase, first product type). */
  types: string[];
  /** lowercase brand; null = none. */
  brand: string | null;
  /** A local (store) product: never written here. */
  local: boolean;
}

/** One entry of a primary source's defaultRule.takeFromDataSources (priority order). */
export interface DataSourceRef {
  self?: boolean;
  supplementalDataSourceName?: string;
  primaryDataSourceName?: string;
}

export interface MerchantDataSource {
  name: string;
  displayName: string;
  kind: "primary" | "supplemental" | "other";
  /** Only API sources take product inputs. */
  api: boolean;
  feedLabel: string;
  contentLanguage: string;
  /** Primary only: the sources it reads, first wins. Empty = only itself. */
  takeFrom: DataSourceRef[];
}

/** Where one product input goes: the product and the supplemental source. */
export interface LabelTarget {
  restId: string;
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
}

const enc = (v: string): string => encodeURIComponent(v);

const query = (q: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

const labelSlotOk = (slot: number): number => {
  if (!Number.isInteger(slot) || slot < 0 || slot > 4)
    throw new TypeError("label slot must be 0-4");
  return slot;
};

const sourceOf = (raw: unknown): MerchantDataSource | null => {
  const ds = asObject(raw);
  const name = asString(ds.name);
  if (!name) return null;
  const primary = ds.primaryProductDataSource;
  const supplemental = ds.supplementalProductDataSource;
  const kind = primary ? "primary" : supplemental ? "supplemental" : "other";
  const block = asObject(primary ?? supplemental);
  const input = asString(ds.input);
  return {
    name,
    displayName: asString(ds.displayName) ?? "",
    kind,
    api: input !== undefined ? input === "API" : ds.fileInput === undefined,
    feedLabel: asString(block.feedLabel) ?? "",
    contentLanguage: asString(block.contentLanguage) ?? "",
    takeFrom: asArray(asObject(asObject(primary).defaultRule).takeFromDataSources).map((r) => {
      const o = asObject(r);
      const ref: DataSourceRef = {};
      if (o.self === true) ref.self = true;
      const s = asString(o.supplementalDataSourceName);
      if (s) ref.supplementalDataSourceName = s;
      const p = asString(o.primaryDataSourceName);
      if (p) ref.primaryDataSourceName = p;
      return ref;
    }),
  };
};

const lower = (v: unknown): string | null => {
  const s = asString(v)?.trim();
  return s ? s.toLowerCase() : null;
};

const productOf = (raw: unknown): MerchantProduct | null => {
  const p = asObject(raw);
  const name = asString(p.name);
  const offerId = asString(p.offerId);
  if (!name || !offerId) return null;
  const at = name.indexOf("/products/");
  if (at < 0) return null;
  const a = asObject(p.productAttributes);
  const firstType = asString(asArray(a.productTypes)[0]) ?? "";
  return {
    name,
    restId: name.slice(at + "/products/".length),
    offerId,
    contentLanguage: asString(p.contentLanguage) ?? "",
    feedLabel: asString(p.feedLabel) ?? "",
    labels: [0, 1, 2, 3, 4].map((i) => lower(a[`customLabel${i}`])),
    types: firstType
      .split(">")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
    brand: lower(a.brand),
    local: p.legacyLocal === true || name.slice(at + "/products/".length).startsWith("local~"),
  };
};

const read = async (t: Transport, path: string): Promise<JsonObject> =>
  asObject((await t.read({ method: "GET", path, opsCost: 0, opsKind: "other" })).json);

const write = async (
  t: Transport,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<JsonObject> =>
  asObject((await t.write({ method, path, body, opsCost: 0, opsKind: "other" })).json);

/**
 * The Merchant Center client. `config` is the Google Ads client's (same sign-in, fetch and
 * logger); requests go to the Merchant API and never count as Google Ads operations.
 */
export const createMerchantClient = (config: AdsClientConfig) => {
  // never Google Ads operations: Merchant Center has its own quota
  const { opsCounter, opsPool, ...rest } = config;
  void opsCounter;
  void opsPool;
  const t = createTransport({ ...rest, host: MERCHANT_API_HOST });

  const listDataSources = async (merchantId: string): Promise<MerchantDataSource[]> => {
    const out: MerchantDataSource[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const json = await read(
        t,
        `datasources/v1/accounts/${assertMerchantId(merchantId)}/dataSources${query({ pageSize: 1000, pageToken })}`,
      );
      for (const ds of asArray(json.dataSources)) {
        const s = sourceOf(ds);
        if (s) out.push(s);
      }
      pageToken = asString(json.nextPageToken);
      if (!pageToken) return out;
    }
    throw new Error("Merchant Center listed more data sources than PerfoAds reads.");
  };

  /** Every product (up to `maxProducts`); capped = there were more. */
  const listProducts = async (
    merchantId: string,
    opts: { maxProducts?: number } = {},
  ): Promise<{ products: MerchantProduct[]; capped: boolean }> => {
    const max = opts.maxProducts ?? MERCHANT_MAX_PRODUCTS;
    const products: MerchantProduct[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const json = await read(
        t,
        `products/v1/accounts/${assertMerchantId(merchantId)}/products${query({ pageSize: PAGE_SIZE, pageToken })}`,
      );
      for (const raw of asArray(json.products)) {
        const p = productOf(raw);
        if (p) products.push(p);
      }
      pageToken = asString(json.nextPageToken);
      if (!pageToken) return { products, capped: false };
      if (products.length >= max) return { products, capped: true };
    }
  };

  /** A new API supplemental source for one feed label + language (empty until written). */
  const createSupplementalSource = async (
    merchantId: string,
    p: { displayName: string; feedLabel: string; contentLanguage: string },
  ): Promise<MerchantDataSource> => {
    const json = await write(
      t,
      "POST",
      `datasources/v1/accounts/${assertMerchantId(merchantId)}/dataSources`,
      {
        displayName: p.displayName,
        supplementalProductDataSource: {
          feedLabel: p.feedLabel,
          contentLanguage: p.contentLanguage,
        },
      },
    );
    const made = sourceOf(json);
    if (!made || !SOURCE_NAME.test(made.name)) {
      throw new Error("Merchant Center made the source but did not say its name.");
    }
    return made;
  };

  const inputPath = (merchantId: string, restId: string, q: Record<string, string>): string =>
    `products/v1/accounts/${assertMerchantId(merchantId)}/productInputs/${enc(restId)}${query(q)}`;

  const assertSource = (merchantId: string, dataSource: string): string => {
    const m = SOURCE_NAME.exec(dataSource);
    if (!m || m[1] !== merchantId) throw new TypeError("not this Merchant Center's source");
    return dataSource;
  };

  /**
   * custom_label_<slot> = value on one product, in `dataSource` only (one-field mask: the
   * product's other fields, and every other source, are left alone). No input there yet =
   * insert one with just that field.
   */
  const setCustomLabel = async (
    merchantId: string,
    product: LabelTarget,
    slot: number,
    value: string,
    dataSource: string,
  ): Promise<void> => {
    const n = labelSlotOk(slot);
    const source = assertSource(merchantId, dataSource);
    try {
      await write(
        t,
        "PATCH",
        inputPath(merchantId, product.restId, {
          dataSource: source,
          updateMask: `product_attributes.custom_label_${n}`,
        }),
        { productAttributes: { [`customLabel${n}`]: value } },
      );
    } catch (err) {
      if (!(err instanceof GoogleAdsApiError) || err.httpStatus !== 404) throw err;
      await write(
        t,
        "POST",
        `products/v1/accounts/${assertMerchantId(merchantId)}/productInputs:insert${query({ dataSource: source })}`,
        {
          offerId: product.offerId,
          contentLanguage: product.contentLanguage,
          feedLabel: product.feedLabel,
          productAttributes: { [`customLabel${n}`]: value },
        },
      );
    }
  };

  /**
   * Takes custom_label_<slot> out of the product's input in `dataSource` (the mask with no
   * value): what the other sources say shows again. No input there = already gone.
   */
  const clearCustomLabel = async (
    merchantId: string,
    product: Pick<LabelTarget, "restId">,
    slot: number,
    dataSource: string,
  ): Promise<"cleared" | "already_gone"> => {
    const n = labelSlotOk(slot);
    try {
      await write(
        t,
        "PATCH",
        inputPath(merchantId, product.restId, {
          dataSource: assertSource(merchantId, dataSource),
          updateMask: `product_attributes.custom_label_${n}`,
        }),
        { productAttributes: {} },
      );
      return "cleared";
    } catch (err) {
      if (err instanceof GoogleAdsApiError && err.httpStatus === 404) return "already_gone";
      throw err;
    }
  };

  return {
    listDataSources,
    listProducts,
    createSupplementalSource,
    setCustomLabel,
    clearCustomLabel,
  };
};

export type MerchantClient = ReturnType<typeof createMerchantClient>;

export type MerchantAccessProblem = "scope" | "api_disabled" | "not_registered" | "no_access";

/**
 * Why Google refused Merchant Center access, or null when it is not an access problem.
 * Google's words decide (its reply has no Google Ads error codes).
 */
export const merchantAccessProblem = (err: unknown): MerchantAccessProblem | null => {
  if (!(err instanceof GoogleAdsApiError) || (err.httpStatus !== 403 && err.httpStatus !== 401)) {
    return null;
  }
  const said = `${err.googleSaid ?? ""} ${err.plainMessage}`.toLowerCase();
  if (said.includes("scope")) return "scope";
  if (said.includes("has not been used") || said.includes("disabled")) return "api_disabled";
  if (said.includes("not registered") || said.includes("registration")) return "not_registered";
  return err.httpStatus === 403 ? "no_access" : null;
};
