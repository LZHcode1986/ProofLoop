/**
 * receipt-writer.f3-digest.spec.ts — PO-S03-I-05 (S03-I-T05, F3)
 *
 * F3（遗留 minor，SR Round 5）：`verifyReceiptDigest` 无针对非对象 JSON 的
 * 专用单测。本 spec 补齐专项矩阵——非对象 JSON（数组/字符串/数字/null/布尔）
 * 与非法 JSON（格式错误/`undefined` 字面量/空文件）必须返回 `false` 且**不抛
 * 异常**（Forbidden shortcut：不允许对非法输入抛未处理异常）；合法对象 JSON
 * 必须正常校验（回归：匹配 true / 篡改 false / 缺 digest false）。
 *
 * `verifyReceiptDigest(filePath: string): boolean` 位于
 * `packages/kernel/src/receipt-writer.ts`（kernel 公开函数）。行为契约：
 *   - 文件不可读 / JSON 解析失败 → false（不抛）；
 *   - 解析结果非对象（数组/字符串/数字/null/布尔）→ false（不抛）；
 *   - 合法对象：`digest` 缺失/非字符串 → false；digest 与内容计算值一致 → true。
 *
 * 纯函数测试：无 mock；真实临时文件。若实现存在缺陷，本矩阵将失败（RED）；
 * 当前预期实现已 fail-closed 符合契约（F3 为测试缺口，非行为缺口）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { verifyReceiptDigest, computeReceiptDigest } from './receipt-writer';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

function makeDigestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-f3-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function validReceipt(): Record<string, unknown> {
  return {
    version: 1,
    type: 'TASK_COMPLETE',
    stage_id: 'S01',
    slice_id: 'S01-F3',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: {},
  };
}

describe('F3 — verifyReceiptDigest non-object JSON matrix (PO-S03-I-05)', () => {
  it('F3: non-object JSON (array/string/number/null/boolean) returns false without throwing', () => {
    const dir = makeDigestDir();
    const cases: Array<[string, string]> = [
      ['array JSON', '[1,2,3]'],
      ['string JSON', '"hello"'],
      ['number JSON', '42'],
      ['null JSON', 'null'],
      ['boolean JSON', 'true'],
    ];
    for (const [label, content] of cases) {
      const filePath = writeJson(dir, `non-object-${label.replace(/\s+/g, '-')}.json`, content);
      let result: boolean = true; // initialized to a "would-be-valid" sentinel
      expect(() => {
        result = verifyReceiptDigest(filePath);
      }, `${label} must not throw`).not.toThrow();
      expect(result, `${label} must be rejected as non-object`).toBe(false);
    }
  });

  it('F3: invalid JSON (malformed/undefined-literal/empty) returns false without throwing', () => {
    const dir = makeDigestDir();
    const cases: Array<[string, string]> = [
      ['malformed JSON', '{invalid'],
      ['undefined literal', 'undefined'],
      ['empty file', ''],
    ];
    for (const [label, content] of cases) {
      const filePath = writeJson(dir, `invalid-${label.replace(/\s+/g, '-')}.json`, content);
      let result: boolean = true;
      expect(() => {
        result = verifyReceiptDigest(filePath);
      }, `${label} must not throw`).not.toThrow();
      expect(result, `${label} must be rejected`).toBe(false);
    }
  });

  it('F3 regression: a valid object receipt still verifies, tampered/missing digest still fail', () => {
    const dir = makeDigestDir();

    // valid: digest matches computed content digest → true
    const receipt = validReceipt();
    const digest = computeReceiptDigest(receipt);
    const goodPath = writeJson(dir, 'valid-receipt.json', JSON.stringify({ ...receipt, digest }));
    expect(verifyReceiptDigest(goodPath)).toBe(true);

    // tampered digest → false (no throw)
    const tamperedPath = writeJson(
      dir,
      'tampered-receipt.json',
      JSON.stringify({ ...receipt, digest: '0'.repeat(64) }),
    );
    expect(() => verifyReceiptDigest(tamperedPath)).not.toThrow();
    expect(verifyReceiptDigest(tamperedPath)).toBe(false);

    // missing digest field → false (no throw)
    const noDigestPath = writeJson(dir, 'no-digest.json', JSON.stringify(receipt));
    expect(() => verifyReceiptDigest(noDigestPath)).not.toThrow();
    expect(verifyReceiptDigest(noDigestPath)).toBe(false);
  });
});
