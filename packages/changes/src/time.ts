// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

/** "2026-10-25 12:00:00" in a time zone (Google's change_event times are in the account's zone). */
export const localDateTime = (ms: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}:${p("second")}`;
};
