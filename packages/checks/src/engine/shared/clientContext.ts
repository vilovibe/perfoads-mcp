// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/**
 * The owner's optional context (`ClientContextInput`) in the provenanced shape
 * the client-context gate reads. Every value carries where it came from:
 * 'client' = the owner typed or confirmed it, 'ai' = a suggestion nobody
 * confirmed. Only 'client' values are declarations.
 */
import type { ClientContextInput } from "./input.js";

export type ContextSource = "client" | "ai";

/** A value plus where it came from. */
export interface Provenanced<T> {
  value: T;
  source: ContextSource;
}

/** A numeric efficiency target the owner declared in free text. */
export interface DeclaredTarget {
  kind: "roas" | "cpa";
  /** low end of the declared range; equals `high` for a single value. */
  low: number;
  /** high end of the declared range; equals `low` for a single value. */
  high: number;
  /** true when the text was open-ended ("6:1+"), i.e. the number is a floor. */
  openEnded: boolean;
}

export interface DeclaredTargetParse {
  value: DeclaredTarget | null;
  /** Why the parse produced what it did. Always set when `value` is null. */
  reason: string | null;
}

export interface CampaignClientContext {
  campaignId: string;
  source: ContextSource;
  purpose: Provenanced<string | null>;
  objective: Provenanced<string | null>;
  conversion: Provenanced<string | null>;
  target: Provenanced<string | null>;
  constraints: Provenanced<string | null>;
  /** parsed from `target`, owner rows only; `value` null when not parseable. */
  declaredTarget: Provenanced<DeclaredTarget | null> & { reason: string | null };
}

export interface AccountClientContext {
  businessType: Provenanced<string | null>;
  tracksPostLeadOutcomes: Provenanced<string | null>;
  grossMarginPct: Provenanced<number | null>;
}

export interface ClientContext {
  account: AccountClientContext;
  /** per-campaign context, keyed by campaign id */
  campaigns: Record<string, CampaignClientContext>;
}

/**
 * Accepted grammar (everything else yields null):
 *   metric   := "roas" | "cpa" | "cost per <word>"   (case-insensitive label)
 *   roasNum  := N ":1" | N "x" | N (only after a ROAS label)
 *   cpaNum   := "$"N | "€"N | "£"N | N (only after a CPA label)
 *   range    := num ("-" | "–" | "—" | "to") num
 *   openEnd  := num "+"
 * A label-less string parses only when the number itself names the metric:
 * "4x" / "3:1" -> ROAS, "$40" -> CPA. A bare "40" is NOT guessed at.
 * When the text declares two metrics the FIRST labelled one wins and `reason`
 * records that the other was dropped.
 */
export function parseDeclaredTarget(raw: string | null | undefined): DeclaredTargetParse {
  const text = String(raw ?? "").trim();
  if (!text) return { value: null, reason: "empty" };

  const lower = text.toLowerCase();
  const labels: Array<{ kind: "roas" | "cpa"; at: number }> = [];
  for (const m of lower.matchAll(/\broas\b/g)) labels.push({ kind: "roas", at: m.index ?? 0 });
  for (const m of lower.matchAll(/\bcpa\b|\bcost per\b/g))
    labels.push({ kind: "cpa", at: m.index ?? 0 });
  labels.sort((a, b) => a.at - b.at);

  const segments: Array<{ kind: "roas" | "cpa" | null; text: string }> = labels.length
    ? labels.map((l, i) => ({
        kind: l.kind,
        text: lower.slice(l.at, labels[i + 1]?.at ?? lower.length),
      }))
    : [{ kind: null, text: lower }];

  const parsedSegments: DeclaredTarget[] = [];
  for (const seg of segments) {
    const t = parseSegment(seg.text, seg.kind);
    if (t) parsedSegments.push(t);
  }

  const first = parsedSegments[0];
  if (!first) return { value: null, reason: "no parsable target" };
  if (parsedSegments.length > 1) {
    return {
      value: first,
      reason: `multiple targets declared (${parsedSegments.map((p) => p.kind).join(", ")}); first labelled metric kept`,
    };
  }
  return { value: first, reason: null };
}

const NUM = String.raw`\d+(?:\.\d+)?`;
const RANGE_SEP = String.raw`(?:\s*(?:-|–|—|to)\s*)`;

/** Parse one metric segment. `kind` is null for label-less text. */
function parseSegment(seg: string, kind: "roas" | "cpa" | null): DeclaredTarget | null {
  // ROAS shapes carry their own marker (":1" or "x"), so they are safe unlabelled.
  const roasNum = String.raw`(${NUM})\s*(?::\s*1|x)`;
  const roasRange = new RegExp(`${roasNum}${RANGE_SEP}${roasNum}`);
  const rr = seg.match(roasRange);
  if (rr && (kind === "roas" || kind === null)) {
    return build("roas", Number(rr[1]), Number(rr[2]), false);
  }
  const rs = seg.match(new RegExp(`${roasNum}\\s*(\\+?)`));
  if (rs && (kind === "roas" || kind === null)) {
    return build("roas", Number(rs[1]), Number(rs[1]), rs[2] === "+");
  }

  // Currency marks a CPA even without a label; a bare number needs the label.
  const cur = String.raw`(?:[$€£]\s*)`;
  const cpaRange = new RegExp(`${cur}?(${NUM})${RANGE_SEP}${cur}?(${NUM})`);
  const cpaSingle = new RegExp(`${cur}(${NUM})\\s*(\\+?)`);
  const cpaLabelled = new RegExp(`${cur}?(${NUM})\\s*(\\+?)`);

  if (kind === "cpa") {
    const cr = seg.match(cpaRange);
    if (cr) return build("cpa", Number(cr[1]), Number(cr[2]), false);
    const cs = seg.match(cpaLabelled);
    if (cs) return build("cpa", Number(cs[1]), Number(cs[1]), cs[2] === "+");
    return null;
  }
  if (kind === null) {
    // Unlabelled: only a currency symbol makes it a CPA.
    if (!/[$€£]/.test(seg)) return null;
    const cr = seg.match(cpaRange);
    if (cr) return build("cpa", Number(cr[1]), Number(cr[2]), false);
    const cs = seg.match(cpaSingle);
    if (cs) return build("cpa", Number(cs[1]), Number(cs[1]), cs[2] === "+");
  }
  return null;
}

function build(
  kind: "roas" | "cpa",
  a: number,
  b: number,
  openEnded: boolean,
): DeclaredTarget | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return { kind, low: Math.min(a, b), high: Math.max(a, b), openEnded };
}

const sourceOf = (s: "owner" | "suggested" | undefined, fallback: ContextSource): ContextSource =>
  s === "owner" ? "client" : s === "suggested" ? "ai" : fallback;

const text = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/**
 * The input in the gate's shape, or null when there is none. A campaign entry
 * without its own `source` inherits the top-level one; with neither, it is an
 * owner answer (the caller supplied it on the owner's behalf).
 */
export function toClientContext(
  input: ClientContextInput | null | undefined,
): ClientContext | null {
  if (!input) return null;
  const top = sourceOf(input.source, "client");
  const a = input.account ?? {};
  const margin =
    a.grossMarginPct == null ? null : Number(String(a.grossMarginPct).replace("%", "").trim());
  const campaigns: Record<string, CampaignClientContext> = {};
  for (const [campaignId, c] of Object.entries(input.campaigns ?? {})) {
    const source = sourceOf(c.source, top);
    const p = <T>(value: T): Provenanced<T> => ({ value, source });
    const targetText = text(c.target);
    const parsed =
      source === "client"
        ? parseDeclaredTarget(targetText)
        : { value: null, reason: "not an owner answer" };
    campaigns[campaignId] = {
      campaignId,
      source,
      purpose: p(text(c.purpose)),
      objective: p(text(c.objective)),
      conversion: p(text(c.conversion)),
      target: p(targetText),
      constraints: p(text(c.constraints)),
      declaredTarget: { value: parsed.value, source, reason: parsed.reason },
    };
  }
  return {
    account: {
      businessType: { value: text(a.businessType), source: top },
      tracksPostLeadOutcomes: { value: text(a.tracksPostLeadOutcomes), source: top },
      grossMarginPct: {
        value: margin != null && Number.isFinite(margin) ? margin : null,
        source: top,
      },
    },
    campaigns,
  };
}
