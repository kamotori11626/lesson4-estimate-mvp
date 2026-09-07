import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/chapter8-test-data-2026-09-06.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../data/raw/12_見積依頼ログ.csv', import.meta.url));
const sourceText = source.toString('utf8');

test('Chapter 8テストデータは原本CSVを固定ハッシュで特定する', () => {
  assert.equal(createHash('sha256').update(source).digest('hex'), fixture.source_sha256);
  assert.equal(sourceText.trimEnd().split(/\r?\n/u).length - 1, fixture.source_row_count);
});

test('正常3件と教材指定のエッジ・禁止事項を用意する', () => {
  assert.equal(fixture.cases.filter(item => item.category === 'normal').length, 3);
  assert.ok(fixture.cases.some(item => item.category === 'edge' && item.name.includes('不足情報')));
  assert.ok(fixture.cases.some(item => item.category === 'edge' && item.name.includes('低粗利')));
  assert.ok(fixture.cases.some(item => item.category === 'edge' && item.name.includes('新規品番')));
  assert.ok(fixture.cases.some(item => item.category === 'prohibited' && item.name.includes('複数商品')));
  assert.ok(fixture.cases.some(item => item.category === 'prohibited' && item.name.includes('矛盾')));
  assert.ok(fixture.cases.some(item => item.category === 'prohibited' && item.name.includes('自動送信')));
});

test('原本由来ケースは対応RFQがCSVに存在し、合成ケースは由来を明記する', () => {
  for (const item of fixture.cases) {
    if (item.source_rfq) assert.match(sourceText, new RegExp(`^${item.source_rfq},`, 'mu'));
    else assert.ok(item.synthetic_reason);
  }
});

test('低粗利ケースの追試入力は原本の16.7%を再現する', () => {
  const item = fixture.cases.find(entry => entry.id === 'E-02');
  const { planned_price: price, cost } = item.approval_input;
  assert.equal(Math.round(((price - cost) / price) * 1000) / 10, 16.7);
});
