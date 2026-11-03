// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { createHash } from "node:crypto";
import { GAQL_RESOURCES } from "./gaqlResources.js";

export const GAQL_DEFAULT_LIMIT = 200;
export const GAQL_MAX_LIMIT = 1000;
const MAX_QUERY_LENGTH = 10_000;
const MAX_FIELDS = 100;

/** PARAMETERS GAQL accepts, each true or false. */
const KNOWN_PARAMETERS = new Set(["include_drafts", "omit_unselected_resource_names"]);

export type GaqlGuardResult =
  | {
      ok: true;
      /** The query that is sent to Google: normalised, with the LIMIT applied. */
      query: string;
      resource: string;
      limit: number;
      /** The selected fields as sent (snake_case, e.g. segments.product_item_id). */
      fields: string[];
      /** Plain-English notes about what the guard changed (LIMIT added or lowered). */
      notes: string[];
    }
  | { ok: false; reason: string };

const reject = (reason: string): GaqlGuardResult => ({ ok: false, reason });

/**
 * Replaces the inside of every quoted string with "x" (same length), so keywords, comments
 * and semicolons inside a literal cannot fool the checks below. undefined = a quote is never closed.
 */
const maskLiterals = (query: string): string | undefined => {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < query.length; i++) {
    const ch = query.charAt(i);
    if (quote) {
      if (ch === "\\" && i + 1 < query.length) {
        out += "xx";
        i++;
      } else if (ch === quote) {
        out += ch;
        quote = undefined;
      } else {
        out += "x";
      }
    } else {
      if (ch === "'" || ch === '"') quote = ch;
      out += ch;
    }
  }
  return quote ? undefined : out;
};

const CLAUSES =
  /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\S+))?(?:\s+PARAMETERS\s+([\s\S]+?))?\s*$/di;

const FIELD = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const ORDER_ITEM = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+(\s+(ASC|DESC))?$/i;
/** Field prefixes with end-customer or staff personal data (also left out of GAQL_RESOURCES). */
const PII_FIELDS =
  /\b(lead_form_submission_data|local_services_lead|local_services_lead_conversation|local_services_employee|local_services_verification_artifact)\.[a-z0-9_.]*|\bcall_view\.caller_[a-z0-9_]*|\bclick_view\.gclid\b/i;
/**
 * Google's own suggestions are not part of the product: recommendations, suggested budgets
 * (campaign_budget.recommended_budget_amount_micros and the other recommended_budget_* fields),
 * anything else named "recommend..." and the optimization score (customer.optimization_score,
 * customer.optimization_score_weight, campaign.optimization_score). Kept: the
 * recommendation_subscription resource (whether Google auto-applies changes; check AS04).
 */
const SUGGESTION_FIELDS =
  /\b(?!recommendation_subscription\.)[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.[a-z0-9_]*(recommend|optimization_score)[a-z0-9_]*(\.[a-z0-9_]+)*/i;
const PARAMETER = /^([a-z_]+)\s*=\s*(true|false)$/i;

/**
 * Read-only guard for query_gaql. Accepts exactly one GAQL SELECT on a known resource:
 *   SELECT fields FROM resource [WHERE ...] [ORDER BY ...] [LIMIT n] [PARAMETERS ...]
 * No comments, no second statement, no sub-queries. LIMIT is added when missing (200) and
 * lowered when above 1000. Google's search endpoint cannot change anything either: this
 * guard keeps queries small, predictable and on resources we know.
 */
export const guardGaql = (
  input: string,
  options: { defaultLimit?: number; maxLimit?: number } = {},
): GaqlGuardResult => {
  const defaultLimit = options.defaultLimit ?? GAQL_DEFAULT_LIMIT;
  const maxLimit = options.maxLimit ?? GAQL_MAX_LIMIT;
  if (input.length > MAX_QUERY_LENGTH)
    return reject("The query is too long (10,000 characters at most).");
  if (input.trim() === "") return reject("The query is empty.");

  const masked = maskLiterals(input);
  if (masked === undefined) return reject("A quoted value is never closed.");
  // Outside quotes: printable ASCII and plain whitespace only (no look-alike letters, no control characters).
  if (/[^\x20-\x7E\t\r\n]/.test(masked)) {
    return reject("The query has characters GAQL does not use outside quoted values.");
  }
  if (/--|\/\*|\*\/|\/\/|#/.test(masked)) return reject("Comments are not allowed in the query.");

  let body = masked;
  const trailing = /;\s*$/.exec(body);
  if (trailing) body = body.slice(0, trailing.index);
  if (body.includes(";")) return reject("Only one statement is allowed (remove the ';').");

  if (!/^\s*SELECT\s/i.test(body)) {
    return reject("Only SELECT queries are allowed. This tool only reads.");
  }

  const m = CLAUSES.exec(body);
  if (!m?.indices) {
    return reject(
      "This is not a GAQL query the server accepts. Shape: SELECT fields FROM resource [WHERE ...] [ORDER BY ...] [LIMIT n] [PARAMETERS ...].",
    );
  }
  const original = (group: number): string | undefined => {
    const span = m.indices?.[group];
    return span ? input.slice(span[0], span[1]).trim() : undefined;
  };

  const fieldsText = m[1] ?? "";
  const fields = fieldsText.split(",").map((f) => f.trim());
  if (fields.length > MAX_FIELDS) return reject(`Too many fields (${MAX_FIELDS} at most).`);
  const badField = fields.find((f) => !FIELD.test(f));
  if (badField !== undefined) {
    return reject(
      `"${badField.slice(0, 60)}" is not a GAQL field. Fields look like campaign.name or metrics.clicks.`,
    );
  }

  // Personal data of the public, even when named from another resource (attributed fields).
  const pii = PII_FIELDS.exec(body);
  if (pii) {
    return reject(
      `"${pii[0].slice(0, 60)}" holds personal data (leads, their messages, callers, click ids or staff), so this tool does not read it.`,
    );
  }

  // Google's own suggestions, even when named from another resource or only in WHERE / ORDER BY.
  const suggestion = SUGGESTION_FIELDS.exec(body);
  if (suggestion) {
    return reject(
      `"${suggestion[0].slice(0, 60)}" is one of Google's own suggestions (recommendations, suggested budgets or the optimization score). PerfoAds does not read or use them.`,
    );
  }

  const resource = m[2] ?? "";
  if (!GAQL_RESOURCES.has(resource)) {
    return reject(
      `"${resource.slice(0, 60)}" is not a Google Ads resource this server knows. Use a lowercase resource name such as campaign, ad_group or search_term_view.`,
    );
  }

  // Personal data: no email field may be selected, filtered or sorted on (change_event.user_email,
  // customer_user_access.email_address, inviter_user_email_address, invitation emails, ...).
  // Checked on the text outside quotes, so a quoted value that says "email" is fine.
  if (/email/i.test(body)) {
    return reject(
      'Email address fields can\'t be read with this tool: they are personal data. Remove every field with "email" in its name (SELECT, WHERE and ORDER BY).',
    );
  }

  const whereMasked = m[3];
  if (whereMasked !== undefined && /\b(SELECT|FROM)\b/i.test(whereMasked)) {
    return reject("Sub-queries are not allowed in WHERE.");
  }
  if (whereMasked !== undefined && /\b(LIMIT|PARAMETERS)\b/i.test(whereMasked)) {
    return reject("LIMIT and PARAMETERS may appear once each, at the end of the query.");
  }

  const orderMasked = m[4];
  if (orderMasked !== undefined) {
    const bad = orderMasked.split(",").find((o) => !ORDER_ITEM.test(o.trim()));
    if (bad !== undefined) return reject("ORDER BY takes fields, each optionally ASC or DESC.");
  }

  const notes: string[] = [];
  let limit = defaultLimit;
  const limitText = m[5];
  if (limitText === undefined) {
    notes.push(`No LIMIT was given, so LIMIT ${defaultLimit} was added.`);
  } else {
    if (!/^\d{1,9}$/.test(limitText) || Number(limitText) < 1) {
      return reject("LIMIT must be a whole number of 1 or more.");
    }
    limit = Number(limitText);
    if (limit > maxLimit) {
      notes.push(`LIMIT ${limit} is above the maximum, so LIMIT ${maxLimit} was used.`);
      limit = maxLimit;
    }
  }

  const paramsMasked = m[6];
  let params: string | undefined;
  if (paramsMasked !== undefined) {
    const parts = paramsMasked.split(",").map((p) => p.trim());
    const parsed = parts.map((p) => PARAMETER.exec(p));
    const bad = parsed.findIndex((p) => !p || !KNOWN_PARAMETERS.has((p[1] ?? "").toLowerCase()));
    if (bad !== -1) {
      return reject(
        "PARAMETERS accepts only include_drafts and omit_unselected_resource_names, each = true or false.",
      );
    }
    params = parsed
      .map((p) => `${(p?.[1] ?? "").toLowerCase()} = ${(p?.[2] ?? "").toLowerCase()}`)
      .join(", ");
  }

  const where = whereMasked === undefined ? "" : ` WHERE ${original(3)}`;
  const order = orderMasked === undefined ? "" : ` ORDER BY ${original(4)}`;
  const query =
    `SELECT ${fields.join(", ")} FROM ${resource}${where}${order} LIMIT ${limit}` +
    (params ? ` PARAMETERS ${params}` : "");
  return { ok: true, query, resource, limit, fields, notes };
};

// ---- Every selected field in every row ----

/** A GAQL field as the REST reply keys it: segments.product_item_id -> ["segments", "productItemId"]. */
export const replyPathOf = (field: string): string[] =>
  field.split(".").map((part) => part.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()));

/**
 * The row with every selected field in it. Google's REST reply leaves out a field whose
 * value is empty or zero (a segment with no value, a metric of 0), so a row can come back
 * without its segments.* or metrics.* fields; each one missing is set to null here, so the
 * reply always has the shape of the SELECT. Values Google sent are kept as they are. Pure.
 */
export const withSelectedFields = (
  row: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = structuredClone(row);
  for (const field of fields) {
    const path = replyPathOf(field);
    let node: Record<string, unknown> = out;
    for (const [i, key] of path.entries()) {
      if (i === path.length - 1) {
        if (!(key in node)) node[key] = null;
        break;
      }
      const next = node[key];
      if (next === undefined || next === null) node[key] = {};
      else if (typeof next !== "object" || Array.isArray(next)) break;
      node = node[key] as Record<string, unknown>;
    }
  }
  return out;
};

/** The note a reply carries when any selected field was missing from a row. */
export const MISSING_FIELDS_NOTE =
  "A null value means Google sent no value for that field in that row (Google leaves out empty and zero values).";

// ---- Cursor: an offset into the rows of one exact query on one account ----

const queryHash = (customerId: string, query: string): string =>
  createHash("sha256").update(`${customerId}\n${query}`).digest("base64url").slice(0, 16);

export const encodeCursor = (customerId: string, query: string, offset: number): string =>
  Buffer.from(JSON.stringify({ v: 1, o: offset, h: queryHash(customerId, query) })).toString(
    "base64url",
  );

/** The offset in the cursor, or a reason it does not fit this query and account. */
export const decodeCursor = (
  cursor: string,
  customerId: string,
  query: string,
): { offset: number } | { error: string } => {
  try {
    const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    const c = raw as { v?: unknown; o?: unknown; h?: unknown };
    if (c.v !== 1 || typeof c.o !== "number" || !Number.isInteger(c.o) || c.o < 0) {
      return { error: "The cursor is not valid. Run the query again without a cursor." };
    }
    if (c.h !== queryHash(customerId, query)) {
      return {
        error:
          "The cursor belongs to a different query or account. Send the same query and customer_id with it.",
      };
    }
    return { offset: c.o };
  } catch {
    return { error: "The cursor is not valid. Run the query again without a cursor." };
  }
};
