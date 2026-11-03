// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/** The host of a URL without scheme, path or "www.", or null. */
export function hostOf(url: string | null | undefined): string | null {
  const u = String(url ?? "").trim();
  if (!u) return null;
  try {
    return (
      new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname
        .toLowerCase()
        .replace(/^www\./, "") || null
    );
  } catch {
    return null;
  }
}

/**
 * The account's placement exclusion rows as criterion keys. Site values become
 * their host (no scheme, path or www), so "https://www.x.com/a" matches "x.com".
 */
export function placementExcludedKeys(
  rows: ReadonlyArray<{ type?: unknown; value?: unknown }>,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const type = String(r.type ?? "").toUpperCase();
    const value = String(r.value ?? "").trim();
    if (!type || !value) continue;
    if (type === "PLACEMENT") {
      const host = hostOf(value);
      if (host) out.add(`PLACEMENT:${host}`);
    }
    out.add(`${type}:${value.toLowerCase()}`);
  }
  return out;
}

/** Hosts of Google's own surfaces (search, Gmail, YouTube itself): never a third-party place. */
const GOOGLE_HOST =
  /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|gmail\.com|youtube\.com|youtu\.be|googleusercontent\.com)$/;
/** Names Google gives its own surfaces in placement reports. */
const GOOGLE_NAMES: ReadonlySet<string> = new Set([
  "google owned & operated",
  "youtube",
  "gmail",
  "discover",
]);

export interface PlacementLike {
  placementType: string | null;
  displayName: string | null;
  targetUrl: string | null;
}

/** "2-com.example.app" / "1-123456789" from a store link or a mobileapp:: value; null otherwise. */
export function appIdOf(raw: string | null | undefined): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const play = /play\.google\.com\/store\/apps\/details\?(?:[^#]*&)?id=([\w.]+)/i.exec(v);
  if (play) return `2-${play[1]}`;
  const ios =
    /apps\.apple\.com\/.*\/id(\d{5,})/i.exec(v) ?? /itunes\.apple\.com\/.*\/id(\d{5,})/i.exec(v);
  if (ios) return `1-${ios[1]}`;
  const plain = v.replace(/^mobileapp::/i, "");
  return /^[12]-[\w.]+$/.test(plain) ? plain : null;
}

/**
 * A Google surface (Google's own products, YouTube or Gmail as a site, a Google app):
 * public facts about who owns the place, not a judgement of it. A YouTube video or
 * channel is someone else's content and is not Google's own.
 */
export function isGoogleOwnedPlacement(p: PlacementLike): boolean {
  const type = String(p.placementType ?? "").toUpperCase();
  if (type === "GOOGLE_PRODUCTS") return true;
  if (
    GOOGLE_NAMES.has(
      String(p.displayName ?? "")
        .trim()
        .toLowerCase(),
    )
  )
    return true;
  if (type === "YOUTUBE_VIDEO" || type === "YOUTUBE_CHANNEL") return false;
  if (type === "MOBILE_APPLICATION") {
    const app = appIdOf(p.targetUrl);
    return !!app && /^2-com\.(google|android)\./i.test(app);
  }
  const host = hostOf(p.targetUrl) ?? hostOf(p.displayName);
  return !!host && GOOGLE_HOST.test(host);
}

/** The account-exclusion key this place would carry (see placementExcludedKeys); null when unknown. */
export function placementExclusionKey(p: PlacementLike): string | null {
  const type = String(p.placementType ?? "").toUpperCase();
  if (type === "MOBILE_APPLICATION") {
    const app = appIdOf(p.targetUrl);
    return app ? `MOBILE_APPLICATION:${app.toLowerCase()}` : null;
  }
  if (type === "YOUTUBE_VIDEO") {
    const m =
      /[?&]v=([\w-]{6,})/.exec(p.targetUrl ?? "") ??
      /youtu\.be\/([\w-]{6,})/.exec(p.targetUrl ?? "");
    return m ? `YOUTUBE_VIDEO:${m[1]!.toLowerCase()}` : null;
  }
  if (type === "WEBSITE" || type === "") {
    const host = hostOf(p.targetUrl) ?? hostOf(p.displayName);
    return host ? `PLACEMENT:${host}` : null;
  }
  return null;
}
