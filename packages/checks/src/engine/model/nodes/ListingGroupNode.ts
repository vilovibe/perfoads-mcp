// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";
import type { ProductNode } from "./ProductNode.js";

export type ListingDimension =
  | { kind: "productItemId"; value: string | null }
  | { kind: "productCustomAttribute"; index: string | null; value: string | null }
  | { kind: "productType"; level: string | null; value: string | null }
  | { kind: "productBrand"; value: string | null }
  | { kind: "productCategory"; level: string | null; value: string | null }
  | { kind: "other"; raw: unknown }
  | { kind: "root" };

export type ProductJoin =
  "item_id_suffix" | "custom_label" | "product_type" | "brand" | "none" | "not_applicable";

export interface ListingGroupAttrs {
  assetGroupId: string;
  type: "SUBDIVISION" | "UNIT_INCLUDED" | "UNIT_EXCLUDED" | string;
  depth: number;
  dimension: ListingDimension;
  /** a dimension with no value = "everything else" under that dimension. */
  isEverythingElse: boolean;
  rawCaseValue: unknown;
  cpcBidMicros: number | null;
  /** how products were joined — see buildPmaxTree.ts header. */
  productJoin: ProductJoin;
}

export interface ListingGroupNode extends BaseNode<"listingGroup"> {
  attrs: ListingGroupAttrs;
  children: { children: ListingGroupNode[]; products: ProductNode[] };
}
