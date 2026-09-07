import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const client = readFileSync(new URL('../public/approval-email.js', import.meta.url), 'utf8');

test('下書き判断の結果欄は判断記録ボタンの直後に置く', () => {
  const button = html.indexOf('id="ae-save-review"');
  const reviewMessage = html.indexOf('id="ae-review-message"');
  const draftEnd = html.indexOf('</div>', reviewMessage);
  assert.ok(button >= 0 && reviewMessage > button && draftEnd > reviewMessage);
  assert.doesNotMatch(html.slice(button, reviewMessage), /id="ae-draft-message"/u);
});

test('判断保存の成功と失敗は下書き生成欄ではなく判断結果欄へ表示する', () => {
  const handler = client.slice(client.indexOf("$('#ae-save-review').addEventListener"));
  assert.match(handler, /#ae-review-message/u);
  assert.doesNotMatch(handler, /#ae-draft-message/u);
});
