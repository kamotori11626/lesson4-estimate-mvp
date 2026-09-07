import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQuotePrices, diceSimilarity, findCustomerCandidates, findProductCandidates, normalizeCustomerName,
  normalizeProductCode, rankPastQuotes, suggestProcessTypes, validateProcessTypeDecision, validateSearchInput } from '../src/similar-search.mjs';

const customers = [
  { customer_id: 'C1', customer_name: 'アサヒ食品機械', billing_name: 'アサヒ食品機械株式会社', delivery_site: '本社', sales_rep: '営業A' },
  { customer_id: 'C2', customer_name: 'アサヒ食品機械株式会社', billing_name: 'アサヒ食品機械株式会社', delivery_site: '大阪', sales_rep: '営業B' },
  { customer_id: 'C3', customer_name: '北斗包装機械', billing_name: '北斗包装機械株式会社', delivery_site: '本社', sales_rep: '営業C' },
  { customer_id: 'C4', customer_name: '三栄メカトロ', billing_name: 'アサヒ食品機械株式会社', delivery_site: '大阪', sales_rep: '営業D' }
];
const products = [
  { product_id: 'P1', product_code: 'POM-120-8', product_name: '樹脂ローラー120', material: 'POM', unit: 'pcs', discontinued_flag: '現行', note: null },
  { product_id: 'P2', product_code: '旧-POM_120_8', product_name: '樹脂ローラー120mm', material: null, unit: '個', discontinued_flag: '', note: '旧表記' },
  { product_id: 'P3', product_code: 'POM-120-8-A', product_name: '樹脂ローラー120A', material: 'POM', unit: '個', discontinued_flag: '現行', note: null }
];
const quotes = [
  { quote_no: 'Q1', quote_date: '2025-09-01', customer_name: 'アサヒ食品機械株式会社', product_code: 'POM1208', material: 'POM', process_type: '樹脂切削', quantity: '10', quote_price: '100000', gross_margin_rate: '0.25', approved_by: '担当者', approval_reason: '', note: '前回同様', drawing_link: 'drive://drawing/1' },
  { quote_no: 'Q2', quote_date: '2024-01-01', customer_name: '北斗包装機械', product_code: 'POM-120-8-A', material: null, process_type: '試作', quantity: '100', quote_price: '250000', gross_margin_rate: '0.2', approved_by: null, approval_reason: null, note: null, drawing_link: null }
];

test('顧客名と品番の表記ゆれを比較用に正規化する', () => {
  assert.equal(normalizeCustomerName('旧：（株）アサヒ食品機械株式会社'), 'アサヒ食品機械');
  assert.equal(normalizeProductCode('旧-POM_120_8'), 'POM1208');
  assert.notEqual(normalizeProductCode('POM-120-8'), normalizeProductCode('POM-120-8-A'));
  assert.equal(diceSimilarity('POM1208', 'POM1208'), 1);
});

test('完全一致と表記ゆれで正しい顧客論理グループが1位になる', () => {
  for (const query of ['アサヒ食品機械', '（株）アサヒ食品機械株式会社']) {
    const result = findCustomerCandidates(customers, query);
    assert.equal(result[0].logical_key, 'アサヒ食品機械');
    assert.equal(result[0].similarity_score, 100);
    assert.equal(result[0].member_count, 2);
    const wrongBilling = result.find(item => item.logical_key === '三栄メカトロ');
    assert.ok(!wrongBilling || wrongBilling.similarity_score <= 60);
  }
});

test('未知の顧客を既存候補として強く提示しない', () => {
  assert.equal(findCustomerCandidates(customers, '未登録顧客テスト').length, 0);
});

test('品番表記ゆれを同じ論理グループにし、末尾型式Aは分ける', () => {
  const result = findProductCandidates(products, { product_code: 'POM_120_8', product_name: '樹脂ローラー120', material: 'POM' });
  assert.equal(result[0].logical_key, 'POM1208');
  assert.equal(result[0].member_count, 2);
  assert.ok(result.some(item => item.logical_key === 'POM1208A'));
});

test('類似見積は固定6キーで根拠・差異・参考価格を返す', () => {
  const customer = findCustomerCandidates(customers, 'アサヒ食品機械')[0];
  const product = findProductCandidates(products, { product_code: 'POM1208', product_name: '樹脂ローラー120', material: 'POM' })[0];
  const result = rankPastQuotes(quotes, { customer_name: 'アサヒ食品機械', product_code: 'POM1208', product_name: '樹脂ローラー120', material: 'POM', process_type: '樹脂切削', quantity: 10, dimensions: null, tolerance: null }, customer, product, '2025-09-26T00:00:00.000Z');
  assert.equal(result[0].quote_id, 'Q1');
  assert.deepEqual(Object.keys(result[0]).sort(), ['data_as_of','differences','match_basis','quote_id','similarity_score','source_link'].sort());
  assert.ok(result[0].match_basis.every(item => Number.isInteger(item.points)));
  assert.equal(result[0].differences.find(item => item.field === 'quote_price').past_value, 100000);
  assert.equal(result[0].differences.find(item => item.field === 'quote_price').status, 'reference_only');
  assert.match(result[0].differences.find(item => item.field === 'quote_price').attention, /単価／総額/);
  assert.equal(result[0].match_basis.find(item => item.field === 'process_type').points, 10);
  assert.ok(result[0].differences.some(item => item.field === 'dimensions' && item.status === 'unverified'));
  const dateObjectResult = rankPastQuotes(quotes, { customer_name: 'アサヒ食品機械', product_code: 'POM1208', product_name: '樹脂ローラー120', material: 'POM', process_type: '樹脂切削', quantity: 10, dimensions: null, tolerance: null }, customer, product, new Date('2025-09-26T00:00:00.000Z'));
  assert.equal(dateObjectResult[0].match_basis.find(item => item.field === 'quote_date').points, 5);
});

test('同一条件の過去実績が一意なら加工種別候補を提示し、人間確認を要求する', () => {
  const customer = findCustomerCandidates(customers, 'アサヒ食品機械')[0];
  const product = findProductCandidates(products, { product_code: 'POM1208', product_name: '樹脂ローラー120', material: 'POM' })[0];
  const history = [
    { ...quotes[0], quote_no: 'Q1', process_type: '樹脂切削' },
    { ...quotes[0], quote_no: 'Q3', quote_date: '2025-08-01', process_type: '樹脂切削' }
  ];
  const suggestion = suggestProcessTypes(history, { material: 'POM', quantity: 10 }, customer, product);
  assert.equal(suggestion.master.available, false);
  assert.equal(suggestion.status, 'single_candidate');
  assert.equal(suggestion.candidates[0].process_type, '樹脂切削');
  assert.equal(suggestion.candidates[0].count, 2);
  assert.equal(suggestion.requires_human_confirmation, true);
  const decision = validateProcessTypeDecision({ source: 'past_history', value: '樹脂切削', confirmed: true,
    confirmed_by: '営業担当', basis: '過去2件が同じ加工種別' }, suggestion);
  assert.equal(decision.value, '樹脂切削');
  assert.equal(decision.final_decision_by_ai, false);
});

test('過去実績の加工種別が複数なら営業の選択を拒否し、技術確認へ回す', () => {
  const customer = findCustomerCandidates(customers, 'アサヒ食品機械')[0];
  const product = findProductCandidates(products, { product_code: 'POM1208', product_name: '樹脂ローラー120', material: 'POM' })[0];
  const history = [
    { ...quotes[0], quote_no: 'Q1', process_type: '樹脂切削' },
    { ...quotes[0], quote_no: 'Q3', quote_date: '2025-08-01', process_type: '研磨' }
  ];
  const suggestion = suggestProcessTypes(history, { material: 'POM', quantity: 10 }, customer, product);
  assert.equal(suggestion.status, 'multiple_candidates');
  assert.throws(() => validateProcessTypeDecision({ source: 'past_history', value: '樹脂切削', confirmed: true,
    confirmed_by: '営業担当', basis: '営業が選択' }, suggestion), /一意な過去実績候補/);
  const routed = validateProcessTypeDecision({ source: 'technical_required', value: null, confirmed: false,
    confirmed_by: '営業担当', basis: '加工種別候補が複数のため技術確認' }, suggestion);
  assert.equal(routed.value, null);
  assert.equal(routed.source, 'technical_required');
});

test('技術担当が確定した加工種別は確認者と根拠を必須にする', () => {
  const suggestion = { status: 'no_candidate', master: { available: false }, candidates: [] };
  assert.throws(() => validateProcessTypeDecision({ source: 'technical_confirmed', value: '板金', confirmed: true,
    confirmed_by: '', basis: '図面確認' }, suggestion), /技術担当/);
  const decision = validateProcessTypeDecision({ source: 'technical_confirmed', value: '板金', confirmed: true,
    confirmed_by: '技術担当A', basis: '図面REV.2と設備条件を確認' }, suggestion);
  assert.equal(decision.value, '板金');
});

function priceQuote(id, date, price, note = null, overrides = {}) {
  const statuses = { product_code: 'same', customer_name: 'same', material: 'same', quantity: 'same', process_type: 'same', ...overrides };
  return { quote_id: id, differences: [
    ...Object.entries(statuses).map(([field, status]) => ({ field, status })),
    { field: 'quote_date', past_value: date, status: 'reference_only' },
    { field: 'quote_price', past_value: price, status: 'reference_only' },
    { field: 'note', past_value: note, status: note ? 'reference_only' : 'unknown' }
  ] };
}

test('比較可能な過去見積は最新案件を基準に差額・差率と3段階を判定する', () => {
  const analysis = analyzeQuotePrices([priceQuote('Q-new', '2025-11-03', 198000), priceQuote('Q-old', '2025-09-12', 250000)]);
  assert.equal(analysis.status, 'alert');
  assert.equal(analysis.severity, 'warning');
  assert.equal(analysis.baseline.quote_id, 'Q-new');
  assert.equal(analysis.highest_risk_comparison.difference_amount, 52000);
  assert.equal(analysis.highest_risk_comparison.difference_percent, 26.26);
  assert.match(analysis.message, /52,000/);
  assert.match(analysis.message, /26\.26%/);
  assert.match(analysis.message, /確認事項/);
  assert.equal(analysis.definition.amount_type, 'unspecified');
  assert.equal(analysis.definition.currency, 'unspecified');
  assert.equal(analysis.definition.tax_treatment, 'unspecified');
});

test('10%未満でも材料高騰注記があれば注意に繰り上げる', () => {
  const analysis = analyzeQuotePrices([
    priceQuote('Q-new', '2024-11-03', 198000, '材料高騰反映'),
    priceQuote('Q-old', '2024-09-12', 185000)
  ]);
  assert.equal(analysis.status, 'alert');
  assert.equal(analysis.severity, 'attention');
  assert.equal(analysis.highest_risk_comparison.difference_amount, 13000);
  assert.equal(analysis.highest_risk_comparison.difference_percent, 6.57);
  assert.match(analysis.message, /材料・原価の変動/);
});

test('差率10%未満で重要注記がなければ警告なしで検索結果を表示する', () => {
  const analysis = analyzeQuotePrices([priceQuote('Q-new', '2025-11-03', 100000), priceQuote('Q-old', '2025-09-12', 105000)]);
  assert.equal(analysis.status, 'within_threshold');
  assert.equal(analysis.severity, 'none');
  assert.equal(analysis.search_results_visible, true);
  assert.match(analysis.message, /通常表示/);
});

test('数量や加工種別が異なり比較可能案件が2件なければ比較不能とする', () => {
  const analysis = analyzeQuotePrices([
    priceQuote('Q-new', '2025-11-03', 100000),
    priceQuote('Q-old', '2025-09-12', 200000, null, { quantity: 'different', process_type: 'different' })
  ]);
  assert.equal(analysis.status, 'comparison_unavailable');
  assert.equal(analysis.adoption_blocked, true);
  assert.deepEqual(analysis.failed_comparable_fields.sort(), ['process_type', 'quantity']);
  assert.equal(analysis.search_results_visible, true);
});

test('検索入力は単一商品の規格品・類似品だけを受け付ける', () => {
  const record = { revision: 3, input_payload: { case_type: '規格品', item_scope: 'single' }, output_payload: { status: 'needs_review', warnings_and_holds: [] } };
  const values = { customer_name: 'アサヒ食品機械', product_name: '樹脂ローラー120', product_code: 'POM1208', material: 'POM', process_type: '樹脂切削', quantity: 10, quantity_unit: '個', dimensions: null, tolerance: null, requested_delivery_date: null };
  assert.deepEqual(validateSearchInput(record, { revision: 3, values, acknowledged: true }), values);
  assert.throws(() => validateSearchInput({ ...record, input_payload: { case_type: '新規特注', item_scope: 'single' } }, { revision: 3, values, acknowledged: true }), /規格品・類似品/);
});
