import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approverText } from '../public/approval-view.js';

test('複数の確認先を読点で区切って表示する', () => {
  assert.equal(approverText(['管理職', '技術担当']), '確認先：管理職、技術担当');
});

test('確認先が1件でも同じ見出し形式で表示する', () => {
  assert.equal(approverText(['管理職']), '確認先：管理職');
});

test('確認先が空なら表示用テキストを返さない', () => {
  assert.equal(approverText([]), null);
});

test('確認先表示を判定概要と既存のルール一覧・JSONの間に置く', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const summary = html.indexOf('id="ae-summary"');
  const approvers = html.indexOf('id="ae-approvers"');
  const rules = html.indexOf('id="ae-rules"');
  const json = html.indexOf('id="ae-json"');
  assert.ok(summary < approvers && approvers < rules && rules < json);
});
