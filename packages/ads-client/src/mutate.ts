// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { GoogleAdsApiError, parseGoogleFailure, type GoogleAdsErrorDetail } from "./errors.js";
import { asArray, asObject, asString, isObject, type JsonObject } from "./json.js";
import { normalizeCustomerId, type AdsResponse, type Transport } from "./transport.js";

export type ResponseContentType = "RESOURCE_NAME_ONLY" | "MUTABLE_RESOURCE";

export interface WriteOptions {
  customerId: string;
  loginCustomerId?: string | undefined;
  /** Google checks every operation and changes nothing. Safe to retry, so it uses the read path. */
  validateOnly?: boolean;
  /**
   * Apply the operations that are valid and report the rest. Only for independent lists
   * (negatives, keywords); default is atomic: all or nothing.
   */
  partialFailure?: boolean;
  /** MUTABLE_RESOURCE returns the changed resource in the reply (used for read-back). */
  responseContentType?: ResponseContentType;
}

export interface OperationResult {
  index: number;
  ok: boolean;
  resourceName: string | undefined;
  /** The resource as Google stored it (MUTABLE_RESOURCE only). */
  resource: JsonObject | undefined;
  errors: GoogleAdsErrorDetail[];
}

export interface MutateResult {
  validateOnly: boolean;
  googleRequestId: string | undefined;
  results: OperationResult[];
  failedCount: number;
  /** Partial-failure errors Google did not tie to one operation. */
  requestErrors: GoogleAdsErrorDetail[];
}

const SERVICE = /^[a-zA-Z]+$/;

const writeBody = (operationsKey: string, operations: unknown[], o: WriteOptions): JsonObject => {
  const body: JsonObject = { [operationsKey]: operations };
  if (o.partialFailure) body.partialFailure = true;
  if (o.validateOnly) body.validateOnly = true;
  if (o.responseContentType) body.responseContentType = o.responseContentType;
  return body;
};

const send = (t: Transport, path: string, body: JsonObject, o: WriteOptions, opsCost: number) => {
  const req = {
    method: "POST" as const,
    path,
    body,
    loginCustomerId: o.loginCustomerId,
    opsCost,
    opsKind: "mutate" as const,
  };
  return o.validateOnly ? t.read(req) : t.write(req);
};

/** `{ resourceName, campaign: {...} }` -> its name and the resource object. */
const unpackResult = (raw: JsonObject): Pick<OperationResult, "resourceName" | "resource"> => {
  const resourceName = asString(raw.resourceName);
  const resourceKey = Object.keys(raw).find((k) => k !== "resourceName" && isObject(raw[k]));
  return { resourceName, resource: resourceKey ? asObject(raw[resourceKey]) : undefined };
};

/** Per-operation outcome. Failed operations come back as empty objects plus partialFailureError. */
const toMutateResult = (
  res: AdsResponse,
  count: number,
  rawResults: JsonObject[],
  validateOnly: boolean,
): MutateResult => {
  const json = asObject(res.json);
  const failure = isObject(json.partialFailureError)
    ? parseGoogleFailure(json.partialFailureError)
    : undefined;
  const details = failure?.details ?? [];
  const results: OperationResult[] = [];
  for (let index = 0; index < count; index++) {
    const errors = details.filter((d) => d.operationIndex === index);
    results.push({
      index,
      ok: errors.length === 0,
      errors,
      ...unpackResult(rawResults[index] ?? {}),
    });
  }
  return {
    validateOnly,
    googleRequestId: res.googleRequestId ?? failure?.googleRequestId,
    results,
    failedCount: results.filter((r) => !r.ok).length,
    requestErrors: details.filter((d) => d.operationIndex === null),
  };
};

/**
 * Per-service mutate, e.g. service "campaignBudgets" -> customers/{id}/campaignBudgets:mutate.
 * Operations are sent as given: `{ create }`, `{ update, updateMask }` or `{ remove }`.
 */
export const mutate = async (
  t: Transport,
  service: string,
  operations: JsonObject[],
  o: WriteOptions,
): Promise<MutateResult> => {
  if (!SERVICE.test(service)) throw new TypeError(`not a Google Ads service name: "${service}"`);
  if (operations.length === 0) throw new RangeError("no operations to send");
  const customerId = normalizeCustomerId(o.customerId);
  const res = await send(
    t,
    `customers/${customerId}/${service}:mutate`,
    writeBody("operations", operations, o),
    o,
    operations.length,
  );
  const raw = asArray(asObject(res.json).results).map(asObject);
  return toMutateResult(res, operations.length, raw, o.validateOnly === true);
};

/** Hands out temporary ids for one GoogleAdsService.Mutate request: -1, -2, -3 ... */
export const createTempIds = (): (() => number) => {
  let next = 0;
  return () => --next;
};

/** "customers/1234567890/campaignBudgets/-1": a resource created earlier in the same request. */
export const tempResourceName = (
  customerId: string,
  collection: string,
  tempId: number,
): string => {
  if (!Number.isInteger(tempId) || tempId >= 0) throw new RangeError("temporary ids are negative");
  if (!SERVICE.test(collection)) throw new TypeError(`not a resource collection: "${collection}"`);
  return `customers/${normalizeCustomerId(customerId)}/${collection}/${tempId}`;
};

/** Every create.resourceName that uses a temporary id, so duplicates are caught before sending. */
const tempNamesCreated = (mutateOperations: JsonObject[]): string[] =>
  mutateOperations.flatMap((op) =>
    Object.values(op)
      .map((inner) => asString(asObject(asObject(inner).create).resourceName))
      .filter((name): name is string => name !== undefined && /\/-\d+$/.test(name)),
  );

/**
 * GoogleAdsService.Mutate: many resource types in one request, atomic by default.
 * Each item is one MutateOperation, e.g. `{ campaignBudgetOperation: { create: {...} } }`.
 * Later operations may point at earlier creates through temporary (negative) ids.
 */
export const mutateAll = async (
  t: Transport,
  mutateOperations: JsonObject[],
  o: WriteOptions,
): Promise<MutateResult> => {
  if (mutateOperations.length === 0) throw new RangeError("no operations to send");
  const created = tempNamesCreated(mutateOperations);
  const dup = created.find((name, i) => created.indexOf(name) !== i);
  if (dup) throw new RangeError(`temporary id used for two creates: ${dup}`);
  const customerId = normalizeCustomerId(o.customerId);
  const res = await send(
    t,
    `customers/${customerId}/googleAds:mutate`,
    writeBody("mutateOperations", mutateOperations, o),
    o,
    mutateOperations.length,
  );
  // Each response holds one "<type>Result" key, e.g. { campaignBudgetResult: { resourceName } }.
  const raw = asArray(asObject(res.json).mutateOperationResponses).map((r) => {
    const obj = asObject(r);
    const key = Object.keys(obj).find((k) => k.endsWith("Result"));
    return key ? asObject(obj[key]) : {};
  });
  return toMutateResult(res, mutateOperations.length, raw, o.validateOnly === true);
};

export type RemoveOutcome = "removed" | "already_removed" | "failed";

export interface RemoveResult {
  googleRequestId: string | undefined;
  validateOnly: boolean;
  results: {
    index: number;
    resourceName: string;
    outcome: RemoveOutcome;
    errors: GoogleAdsErrorDetail[];
  }[];
}

const onlyNotFound = (errors: readonly GoogleAdsErrorDetail[]): boolean =>
  errors.length > 0 && errors.every((e) => e.errorCode?.value === "RESOURCE_NOT_FOUND");

/**
 * Removes resources, treating "already gone" as success, so an undo or a repeated
 * cleanup does not fail on a row someone else removed. Sent with partial failure,
 * so one missing row does not block the others. Only the exact code RESOURCE_NOT_FOUND
 * counts: look-alikes such as RESOURCE_TEMPORARILY_NOT_FOUND stay failures.
 */
export const removeIdempotent = async (
  t: Transport,
  service: string,
  resourceNames: string[],
  o: Omit<WriteOptions, "partialFailure" | "responseContentType">,
): Promise<RemoveResult> => {
  const operations = resourceNames.map((remove) => ({ remove }));
  const validateOnly = o.validateOnly === true;
  try {
    const res = await mutate(t, service, operations, { ...o, partialFailure: true });
    return {
      googleRequestId: res.googleRequestId,
      validateOnly,
      results: res.results.map((r) => ({
        index: r.index,
        resourceName: resourceNames[r.index] ?? "",
        errors: r.errors,
        outcome: r.ok ? "removed" : onlyNotFound(r.errors) ? "already_removed" : "failed",
      })),
    };
  } catch (err) {
    // Google can still refuse the whole request. If every operation was refused only
    // because it is already gone, the end state is reached.
    if (!(err instanceof GoogleAdsApiError) || !onlyNotFound(err.details)) throw err;
    const covered = resourceNames.every((_, i) => err.details.some((d) => d.operationIndex === i));
    if (!covered && resourceNames.length > 1) throw err;
    return {
      googleRequestId: err.googleRequestId,
      validateOnly,
      results: resourceNames.map((resourceName, index) => ({
        index,
        resourceName,
        outcome: "already_removed",
        errors: err.details.filter((d) => d.operationIndex === index),
      })),
    };
  }
};
