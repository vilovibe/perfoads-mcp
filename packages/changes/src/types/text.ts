// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Checks for text the model writes (keywords, negatives, ad text, asset text). The text is
// sent exactly as given after trimming and joining runs of spaces; nothing else is changed
// silently. Invisible and control characters, bidi controls and emoji are refused (they can
// make text read differently on the approval page than in the ad).

import { z } from "zod";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Bidi controls, zero-width characters, the BOM and soft hyphen. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const EMOJI = /\p{Extended_Pictographic}/u;

/** Google counts these as 2 characters in ad text (East Asian wide / full width). */
const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]/u;

/** Display length the way Google counts ad text: wide characters count 2. */
export const adTextLength = (text: string): number => {
  let n = 0;
  for (const ch of text) n += WIDE.test(ch) ? 2 : 1;
  return n;
};

/** Trim and join runs of spaces (the only clean-up done to model text). */
export const tidy = (text: string): string => text.trim().replace(/ {2,}/g, " ");

const plainProblem = (text: string): string | null => {
  if (CONTROL.test(text)) return "has control characters or line breaks";
  if (INVISIBLE.test(text)) return "has invisible or direction-changing characters";
  if (EMOJI.test(text)) return "has emoji (Google refuses them in ads and keywords)";
  return null;
};

/** Keyword and negative keyword text: Google's limits (80 characters, 10 words) and charset. */
const KEYWORD_BAD = /[!@%,*()^={};~`<>?\\|"[\]]/;
export const KEYWORD_MAX_CHARS = 80;
export const KEYWORD_MAX_WORDS = 10;

export const keywordTextSchema = z.string().transform((raw, ctx) => {
  const text = tidy(raw);
  const fail = (message: string) => {
    ctx.addIssue({ code: "custom", message });
    return z.NEVER;
  };
  if (!text) return fail("must not be empty");
  const plain = plainProblem(text);
  if (plain) return fail(plain);
  if (/^["[]|["\]]$/.test(text)) {
    return fail('write the words only; set match_type instead of [brackets] or "quotes"');
  }
  if (KEYWORD_BAD.test(text)) {
    return fail(
      "has characters Google does not take in keywords (! @ % , * ( ) ^ = { } ; ~ < > ? \\ |)",
    );
  }
  if (text.length > KEYWORD_MAX_CHARS) return fail(`is over ${KEYWORD_MAX_CHARS} characters`);
  if (text.split(" ").length > KEYWORD_MAX_WORDS) return fail(`is over ${KEYWORD_MAX_WORDS} words`);
  return text;
});

/** Ad / asset text up to `max` (Google's count: wide characters count 2). */
export const adTextSchema = (max: number, opts: { allowEmpty?: boolean } = {}) =>
  z.string().transform((raw, ctx) => {
    const text = tidy(raw);
    const fail = (message: string) => {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    };
    if (!text) return opts.allowEmpty ? "" : fail("must not be empty");
    const plain = plainProblem(text);
    if (plain) return fail(plain);
    const len = adTextLength(text);
    if (len > max) return fail(`is ${len} characters; at most ${max}`);
    return text;
  });

/**
 * A final URL: http(s), no spaces or control characters, at most 2,048 characters. Sent as
 * the URL parser writes it (url.href), so the approval page shows exactly what is sent. A
 * host with non-ASCII letters is refused: it can look like another site (Cyrillic "а"
 * for Latin "a"); write it in punycode (xn--...) if it is really meant.
 */
export const finalUrlSchema = z.string().transform((raw, ctx) => {
  const text = raw.trim();
  const fail = (message: string) => {
    ctx.addIssue({ code: "custom", message });
    return z.NEVER;
  };
  if (!text || text.length > 2048) return fail("must be a URL of 1-2,048 characters");
  if (/\s/.test(text) || plainProblem(text))
    return fail("must not hold spaces or hidden characters");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail("is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return fail("must start with https://");
  if (url.username || url.password) return fail("must not hold a user name or password");
  const rawHost = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-\u007f]/.test(rawHost)) {
    return fail(
      "has non-ASCII letters in the site name, which can look like another site; write it in punycode (xn--...) if it is really meant",
    );
  }
  if (url.href.length > 2048) return fail("is over 2,048 characters once written out");
  return url.href;
});

/**
 * A URL in the form used to compare two of them: written out by the same URL parser that
 * finalUrlSchema sends (lower-case host, "/" for an empty path). Not a URL: as given.
 */
export const comparableUrl = (raw: string): string => {
  try {
    return new URL(raw.trim()).href;
  } catch {
    return raw.trim();
  }
};

/** Lower case, single spaces: how duplicates are compared (Google ignores case in keywords). */
export const normKeyword = (text: string): string => tidy(text).toLowerCase();
