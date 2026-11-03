// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import type { BaseNode } from "../types.js";
import type { ProductNode } from "./ProductNode.js";

/** Shopping partition tree. No * table holds it today (G.4/G.6) — the type exists so the tree is not silently skipped. */
export interface ProductGroupAttrs {
  dimension: unknown;
  cpcBid: number | null;
}

export interface ProductGroupNode extends BaseNode<"productGroup"> {
  attrs: ProductGroupAttrs;
  children: { children: ProductGroupNode[]; products: ProductNode[] };
}
