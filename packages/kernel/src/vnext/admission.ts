/** Closed vNext admission authority schemas and digest helpers. */

import { computeDigest, isSha256Hex } from "./canonical";
import { VNEXT_SCHEMA_VERSION } from "./types";
import type { VNextSpvPassReceipt, VNextStagePlanReceipt } from "./types";
import {
  collectErrors,
  checkUnknownFields,
  expectNonEmptyString,
  expectObject,
  expectSha256Hex,
} from "./internal";

const SPV_FIELDS = new Set([
  "version", "schema_version", "type", "stage_id", "manifest_digest",
  "plan_digest", "snapshot_digest", "digest",
]);
const STAGE_PLAN_FIELDS = new Set([
  "version", "schema_version", "type", "stage_id", "manifest_digest",
  "plan_digest", "snapshot_digest", "spv_receipt_digest", "digest",
]);

export function computeVNextSpvPassReceiptDigest(
  receipt: Omit<VNextSpvPassReceipt, "digest">,
): string {
  return computeDigest(receipt);
}

export function computeVNextStagePlanReceiptDigest(
  receipt: Omit<VNextStagePlanReceipt, "digest">,
): string {
  return computeDigest(receipt);
}

function checkSelfDigest(
  object: Record<string, unknown>,
  label: string,
  compute: (value: any) => string,
  errors: Array<{ path: string; message: string }>,
): void {
  const digest = object.digest;
  if (!isSha256Hex(digest)) return;
  const { digest: ignored, ...withoutDigest } = object;
  void ignored;
  if (compute(withoutDigest) !== digest) {
    errors.push({ path: label + ".digest", message: "Digest does not match canonical receipt content" });
  }
}

export function validateVNextSpvPassReceipt(value: unknown): VNextSpvPassReceipt {
  return collectErrors("VNextSpvPassReceipt", (errors) => {
    const obj = expectObject(value, "receipt", errors);
    if (!obj) return undefined;
    checkUnknownFields(obj, SPV_FIELDS, "receipt", errors);
    if (obj.version !== VNEXT_SCHEMA_VERSION) errors.push({ path: "receipt.version", message: "Expected 2" });
    if (obj.schema_version !== VNEXT_SCHEMA_VERSION) errors.push({ path: "receipt.schema_version", message: "Expected 2" });
    if (obj.type !== "SPV_PASS") errors.push({ path: "receipt.type", message: "Expected SPV_PASS" });
    expectNonEmptyString(obj.stage_id, "receipt.stage_id", errors);
    expectSha256Hex(obj.manifest_digest, "receipt.manifest_digest", errors);
    expectSha256Hex(obj.plan_digest, "receipt.plan_digest", errors);
    expectNonEmptyString(obj.snapshot_digest, "receipt.snapshot_digest", errors);
    expectSha256Hex(obj.digest, "receipt.digest", errors);
    checkSelfDigest(obj, "receipt", computeVNextSpvPassReceiptDigest, errors);
    return obj as unknown as VNextSpvPassReceipt;
  }) as VNextSpvPassReceipt;
}

export function validateVNextStagePlanReceipt(value: unknown): VNextStagePlanReceipt {
  return collectErrors("VNextStagePlanReceipt", (errors) => {
    const obj = expectObject(value, "receipt", errors);
    if (!obj) return undefined;
    checkUnknownFields(obj, STAGE_PLAN_FIELDS, "receipt", errors);
    if (obj.version !== VNEXT_SCHEMA_VERSION) errors.push({ path: "receipt.version", message: "Expected 2" });
    if (obj.schema_version !== VNEXT_SCHEMA_VERSION) errors.push({ path: "receipt.schema_version", message: "Expected 2" });
    if (obj.type !== "STAGE_PLAN") errors.push({ path: "receipt.type", message: "Expected STAGE_PLAN" });
    expectNonEmptyString(obj.stage_id, "receipt.stage_id", errors);
    expectSha256Hex(obj.manifest_digest, "receipt.manifest_digest", errors);
    expectSha256Hex(obj.plan_digest, "receipt.plan_digest", errors);
    expectNonEmptyString(obj.snapshot_digest, "receipt.snapshot_digest", errors);
    expectSha256Hex(obj.spv_receipt_digest, "receipt.spv_receipt_digest", errors);
    expectSha256Hex(obj.digest, "receipt.digest", errors);
    checkSelfDigest(obj, "receipt", computeVNextStagePlanReceiptDigest, errors);
    return obj as unknown as VNextStagePlanReceipt;
  }) as VNextStagePlanReceipt;
}
