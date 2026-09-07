import { randomUUID } from 'node:crypto';
import { ExtractionError } from './extraction.mjs';

export const SEARCH_SCHEMA_VERSION = 'similar-search-1.2';
export const SEARCH_RULE_VERSION = 'similar-search-rules-1.2';
export const PRICE_DIFFERENCE_RULE_VERSION = 'price-difference-rules-1.0';
export const PROCESS_TYPE_RULE_VERSION = 'process-type-routing-1.0';
export const PRICE_DIFFERENCE_THRESHOLDS = Object.freeze({ attention_percent: 10, warning_percent: 20, stop_percent: 30 });
export const MAX_ENTITY_CANDIDATES = 3;
export const MAX_QUOTE_CANDIDATES = 5;
export const SEARCH_TEST_QUERIES = Object.freeze([
  { id: 'exact', label: '完全一致：アサヒ食品機械／POM-120-8', customer_name: 'アサヒ食品機械', product_code: 'POM-120-8', product_name: '樹脂ローラー120', material: 'POM', process_type: '樹脂切削', quantity: 5, quantity_unit: '個' },
  { id: 'variant', label: '表記ゆれ：（株）アサヒ食品機械／POM_120_8', customer_name: '（株）アサヒ食品機械', product_code: 'POM_120_8', product_name: '樹脂ローラー120mm', material: 'POM', process_type: '樹脂切削', quantity: 10, quantity_unit: '個' },
  { id: 'none', label: '該当なし：未登録顧客／UNKNOWN-999', customer_name: '未登録顧客テスト', product_code: 'UNKNOWN-999', product_name: '未登録商品テスト', material: null, process_type: null, quantity: 1, quantity_unit: '個' },
  { id: 'multiple', label: '複数候補：京浜ロボティクス／ALBKT22', customer_name: '京浜ロボティクス', product_code: 'ALBKT22', product_name: 'アルミブラケット22', material: 'A5052', process_type: '試作', quantity: 50, quantity_unit: '個' }
]);
const stopCodes = new Set(['MULTIPLE_ITEMS', 'OUT_OF_MVP', 'OUT_OF_SCOPE', 'ITEM_COUNT_UNCERTAIN', 'SCOPE_UNCERTAIN']);

const text = value => String(value ?? '').normalize('NFKC').trim();
const compact = value => text(value).toLowerCase().replace(/[\s\-ー_・.,，．()（）]/g, '');
const stripOld = value => text(value).replace(/^旧\s*[:：\-]\s*/, '');
const corporate = /株式会社|有限会社|合同会社|\(株\)|（株）|co\.?[,]?\s*ltd\.?/gi;

export function normalizeCustomerName(value) {
  return compact(stripOld(value).replace(corporate, ''));
}

export function normalizeProductCode(value) {
  return compact(stripOld(value)).toUpperCase();
}

export function normalizeProductName(value) {
  return compact(stripOld(value));
}

function bigrams(value) {
  const source = ` ${value} `;
  return Array.from({ length: Math.max(0, source.length - 1) }, (_, index) => source.slice(index, index + 2));
}

export function diceSimilarity(left, right) {
  const a = text(left), b = text(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const remaining = bigrams(b);
  let matches = 0;
  for (const gram of bigrams(a)) {
    const index = remaining.indexOf(gram);
    if (index >= 0) { matches += 1; remaining.splice(index, 1); }
  }
  return (2 * matches) / (bigrams(a).length + bigrams(b).length);
}

function group(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()];
}

function customerScore(query, members) {
  const q = normalizeCustomerName(query);
  let best = { score: 0, matched_value: null, match_type: 'none' };
  for (const member of members) {
    const normalized = normalizeCustomerName(member.customer_name);
    const similarity = diceSimilarity(q, normalized);
    const score = normalized === q ? 100 : (normalized.includes(q) || q.includes(normalized)) ? 82 : Math.round(similarity * 70);
    if (score > best.score) best = { score, matched_value: member.customer_name, match_type: normalized === q ? 'normalized_exact' : 'fuzzy' };
    // Billing names are error-prone in the supplied master. They may retrieve a candidate,
    // but can never make a different customer-name group an exact/automatic match.
    const billing = normalizeCustomerName(member.billing_name);
    const billingSimilarity = diceSimilarity(q, billing);
    const billingScore = billing === q ? 60 : Math.round(billingSimilarity * 45);
    if (billingScore > best.score) best = { score: billingScore, matched_value: member.billing_name, match_type: 'billing_name_only' };
  }
  return best;
}

export function findCustomerCandidates(rows, query, limit = MAX_ENTITY_CANDIDATES) {
  if (!text(query)) return [];
  return group(rows, row => normalizeCustomerName(row.customer_name))
    .map(([logicalKey, members]) => {
      const match = customerScore(query, members);
      const names = [...new Set(members.flatMap(row => [row.customer_name, row.billing_name]).filter(Boolean))];
      return { candidate_id: `customer:${logicalKey}`, entity_type: 'customer', logical_key: logicalKey,
        similarity_score: match.score, match_basis: [{ field: match.match_type === 'billing_name_only' ? 'billing_name' : 'customer_name', query_value: query,
          matched_value: match.matched_value, match_type: match.match_type, reason: match.match_type === 'normalized_exact' ? '法人格・旧表記・記号を除いた顧客名が一致' : match.match_type === 'billing_name_only' ? '請求名だけが一致または類似。顧客名不一致のため補助候補' : '顧客名の文字列類似' }],
        warnings: [...(members.length > 1 ? ['同じ論理名に複数の顧客マスタ行があります。拠点・請求名を確認してください。'] : []),
          ...(members.some(row => row.billing_name && normalizeCustomerName(row.billing_name) !== logicalKey) ? ['顧客名と請求名が一致しないマスタ行があります。請求名だけで名寄せしないでください。'] : []),
          ...(match.match_type === 'billing_name_only' ? ['請求名だけが一致した補助候補です。顧客名として自動確定できません。'] : [])],
        member_count: members.length, members: members.map(row => ({ customer_id: row.customer_id, customer_name: row.customer_name,
          billing_name: row.billing_name, delivery_site: row.delivery_site, sales_rep: row.sales_rep })) };
    })
    .filter(candidate => candidate.similarity_score >= 35)
    .sort((a, b) => b.similarity_score - a.similarity_score || a.logical_key.localeCompare(b.logical_key, 'ja'))
    .slice(0, limit);
}

function currentProductRank(row) {
  const flag = text(row.discontinued_flag);
  const old = /^旧\s*[:：\-]/.test(text(row.product_code));
  return (flag === '現行' ? 2 : flag ? 0 : 1) - (old ? 1 : 0);
}

export function findProductCandidates(rows, query, limit = MAX_ENTITY_CANDIDATES) {
  const code = normalizeProductCode(query.product_code);
  const name = normalizeProductName(query.product_name);
  const material = compact(query.material);
  if (!code && !name) return [];
  return group(rows, row => normalizeProductCode(row.product_code))
    .map(([logicalKey, members]) => {
      const codeSimilarity = code ? diceSimilarity(code, logicalKey) : 0;
      const nameSimilarity = name ? Math.max(...members.map(row => diceSimilarity(name, normalizeProductName(row.product_name)))) : 0;
      const codeExact = Boolean(code && code === logicalKey);
      const nameExact = Boolean(name && members.some(row => normalizeProductName(row.product_name) === name));
      let score = codeExact ? 100 : Math.round(codeSimilarity * 68);
      if (!code) score = nameExact ? 82 : Math.round(nameSimilarity * 70);
      if (material && members.some(row => compact(row.material) === material)) score = Math.min(100, score + 8);
      const ordered = [...members].sort((a, b) => currentProductRank(b) - currentProductRank(a) || String(a.product_id).localeCompare(String(b.product_id)));
      const warnings = [];
      if (members.length > 1) warnings.push('同じ論理品番に複数の商品マスタ行があります。旧表記・材質・単位・廃番状態を確認してください。');
      if (members.some(row => !text(row.material))) warnings.push('材質が欠損している商品マスタ行があります。');
      if (!codeExact) warnings.push('論理品番の完全一致ではありません。候補を推測で確定しないでください。');
      return { candidate_id: `product:${logicalKey}`, entity_type: 'product', logical_key: logicalKey,
        similarity_score: score, match_basis: [
          { field: 'product_code', query_value: query.product_code ?? null, matched_value: ordered[0]?.product_code ?? null,
            match_type: codeExact ? 'normalized_exact' : 'fuzzy', reason: codeExact ? '旧表記・区切り記号を除いた論理品番が一致' : '品番または品名の文字列類似' },
          { field: 'product_name', query_value: query.product_name ?? null, matched_value: ordered[0]?.product_name ?? null,
            match_type: nameExact ? 'normalized_exact' : name ? 'fuzzy' : 'not_used', reason: '品名は品番欠損・複数候補時の補助条件' }
        ], warnings, member_count: members.length,
        members: ordered.map(row => ({ product_id: row.product_id, product_code: row.product_code, product_name: row.product_name,
          material: row.material, unit: row.unit, discontinued_flag: row.discontinued_flag, note: row.note })) };
    })
    .filter(candidate => candidate.similarity_score >= 35)
    .sort((a, b) => b.similarity_score - a.similarity_score || a.logical_key.localeCompare(b.logical_key, 'ja'))
    .slice(0, limit);
}

function factor(field, current, past, matchType, points, reason) {
  return { field, current_value: current ?? null, past_value: past ?? null, match_type: matchType, points, reason };
}
function difference(field, current, past, status, attention) {
  return { field, current_value: current ?? null, past_value: past ?? null, status, attention };
}

function dayDiff(later, earlier) {
  const a = Date.parse(`${later}T00:00:00Z`), b = Date.parse(`${earlier}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.floor((a - b) / 86_400_000) : null;
}
function isoDay(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  const valueText = text(value);
  return /^\d{4}-\d{2}-\d{2}/.test(valueText) ? valueText.slice(0, 10) : '';
}

export function rankPastQuotes(rows, query, selectedCustomer, selectedProduct, dataAsOf, limit = MAX_QUOTE_CANDIDATES) {
  if (!selectedProduct?.logical_key) throw new ExtractionError('PRODUCT_SELECTION_REQUIRED', '商品候補を選択してください。');
  const customerKey = selectedCustomer?.logical_key ?? normalizeCustomerName(query.customer_name);
  const productKey = selectedProduct.logical_key;
  const currentMaterial = compact(query.material);
  const currentProcess = compact(query.process_type);
  const currentQuantity = Number(query.quantity);
  const snapshotDay = isoDay(dataAsOf);
  return rows.map(row => {
    const quoteProduct = normalizeProductCode(row.product_code);
    const productSimilarity = diceSimilarity(productKey, quoteProduct);
    const exactProduct = quoteProduct === productKey;
    const productPoints = exactProduct ? 40 : productSimilarity >= 0.65 ? Math.round(productSimilarity * 18) : 0;
    if (!productPoints) return null;
    const quoteCustomer = normalizeCustomerName(row.customer_name);
    const exactCustomer = Boolean(customerKey && quoteCustomer === customerKey);
    const customerSimilarity = customerKey ? diceSimilarity(customerKey, quoteCustomer) : 0;
    const customerPoints = exactCustomer ? 20 : customerSimilarity >= 0.72 ? Math.round(customerSimilarity * 10) : 0;
    const quoteMaterial = compact(row.material);
    const materialPoints = currentMaterial && quoteMaterial && currentMaterial === quoteMaterial ? 15 : 0;
    const quoteProcess = compact(row.process_type);
    const processExact = Boolean(currentProcess && quoteProcess && currentProcess === quoteProcess);
    const processPoints = processExact ? 10 : 0;
    const quoteQuantity = Number(row.quantity);
    const exactQuantity = Number.isFinite(currentQuantity) && Number.isFinite(quoteQuantity) && currentQuantity === quoteQuantity;
    const ratio = Number.isFinite(currentQuantity) && currentQuantity > 0 && Number.isFinite(quoteQuantity) ? quoteQuantity / currentQuantity : null;
    const quantityPoints = exactQuantity ? 10 : ratio !== null && ratio >= 0.5 && ratio <= 2 ? 5 : 0;
    const age = dayDiff(snapshotDay, row.quote_date);
    const recencyPoints = age !== null && age >= 0 && age <= 365 ? 5 : age !== null && age <= 730 ? 3 : 0;
    const matchBasis = [
      factor('product_code', query.product_code, row.product_code, exactProduct ? 'normalized_exact' : 'fuzzy', productPoints, exactProduct ? '論理品番が一致' : '品番文字列が類似'),
      factor('customer_name', query.customer_name, row.customer_name, exactCustomer ? 'normalized_exact' : customerPoints ? 'fuzzy' : 'different', customerPoints, exactCustomer ? '顧客論理名が一致' : customerPoints ? '顧客名が類似' : '顧客一致なし'),
      factor('material', query.material, row.material, !row.material ? 'unknown' : materialPoints ? 'exact' : 'different', materialPoints, !row.material ? '過去見積の材質が欠損' : materialPoints ? '材質が一致' : '材質が不一致'),
      factor('quantity', query.quantity, quoteQuantity, exactQuantity ? 'exact' : quantityPoints ? 'near' : 'different', quantityPoints, exactQuantity ? '数量が一致' : quantityPoints ? '数量が0.5〜2倍' : '数量差が大きいか比較不能'),
      factor('process_type', query.process_type, row.process_type, !currentProcess ? 'not_used' : !quoteProcess ? 'unknown' : processExact ? 'exact' : 'different', processPoints,
        !currentProcess ? '今回の加工種別が未入力のため得点化しない' : !quoteProcess ? '過去見積の加工種別が欠損' : processExact ? '加工種別が一致' : '加工種別が不一致'),
      factor('quote_date', snapshotDay, row.quote_date, recencyPoints === 5 ? 'within_1_year' : recencyPoints === 3 ? 'within_2_years' : 'older', recencyPoints, '固定データ基準日からの経過日数で評価')
    ];
    const differences = [
      difference('product_code', query.product_code, row.product_code, exactProduct ? 'same' : 'different', exactProduct ? '区切り・旧表記差を含む論理一致。商品マスタの重複は別途確認してください。' : '別型式の可能性があります。技術確認なしに価格を転用しないでください。'),
      difference('customer_name', query.customer_name, row.customer_name, exactCustomer ? 'same' : 'different', exactCustomer ? '法人格等を除いた論理一致です。拠点差を確認してください。' : '別顧客の参考案件です。顧客別条件を転用しないでください。'),
      difference('material', query.material, row.material, !row.material ? 'unknown' : materialPoints ? 'same' : 'different', !row.material ? '過去材質が欠損し比較できません。' : materialPoints ? '材質一致。規格・グレードの詳細は別途確認してください。' : '材質差があります。'),
      difference('quantity', query.quantity, quoteQuantity, exactQuantity ? 'same' : 'different', exactQuantity ? '数量一致。' : '数量差により単価・工数が変わる可能性があります。'),
      difference('process_type', query.process_type, row.process_type,
        !currentProcess || !quoteProcess ? 'unverified' : processExact ? 'same' : 'different',
        !currentProcess ? '今回の加工種別が未入力です。技術担当に確認してください。' : !quoteProcess ? '過去見積の加工種別が欠損しています。' : processExact ? '加工種別は一致します。詳細工程は別途確認してください。' : '加工種別が異なります。過去価格を転用しないでください。'),
      difference('dimensions', query.dimensions, null, 'unverified', '過去見積CSVに寸法カラムがなく比較できません。'),
      difference('tolerance', query.tolerance, null, 'unverified', '過去見積CSVに公差カラムがなく比較できません。'),
      difference('quote_date', null, row.quote_date, 'reference_only', '過去見積日です。現在の有効価格を保証しません。'),
      difference('quote_price', null, Number(row.quote_price), 'reference_only', '過去見積CSVのquote_price原値です。単価／総額、通貨、税区分は原本で未定義のため、今回価格を自動確定しません。'),
      difference('gross_margin_rate', null, row.gross_margin_rate === null ? null : Number(row.gross_margin_rate), 'restricted_reference', '内部参考値です。外部AIへ送信せず、権限のある利用者だけが扱います。'),
      difference('note', null, row.note, row.note ? 'reference_only' : 'unknown', row.note ? '過去の注意事項です。現在も有効か確認してください。' : '注意事項の記録がありません。')
    ];
    return { quote_id: row.quote_no, similarity_score: matchBasis.reduce((sum, item) => sum + item.points, 0),
      match_basis: matchBasis, differences, source_link: row.drawing_link || null, data_as_of: dataAsOf };
  }).filter(Boolean)
    .sort((a, b) => b.similarity_score - a.similarity_score
      || Number(b.match_basis[0].match_type === 'normalized_exact') - Number(a.match_basis[0].match_type === 'normalized_exact')
      || Number(b.match_basis[1].match_type === 'normalized_exact') - Number(a.match_basis[1].match_type === 'normalized_exact')
      || String(b.differences.find(d => d.field === 'quote_date')?.past_value).localeCompare(String(a.differences.find(d => d.field === 'quote_date')?.past_value))
      || a.quote_id.localeCompare(b.quote_id))
    .slice(0, limit);
}

export function suggestProcessTypes(rows, query, selectedCustomer, selectedProduct) {
  const masterValues = [...new Set((selectedProduct?.members || [])
    .flatMap(row => [row.standard_process_type, row.process_type]).map(text).filter(Boolean))];
  const common = {
    rule_version: PROCESS_TYPE_RULE_VERSION,
    master: masterValues.length === 1
      ? { available: true, value: masterValues[0], source: 'product_master', note: '商品マスタの確定済み加工種別です。' }
      : { available: false, value: null, source: 'product_master',
        note: masterValues.length > 1 ? '商品マスタ内で加工種別が競合しています。技術担当が確認してください。'
          : '現在の20_商品マスタには加工種別列がないため、自動取得できません。' },
    candidates: [], requires_human_confirmation: true, final_decision_by_ai: false,
    security: { execution: 'local_postgresql_rules', external_ai_calls: 0 }
  };
  if (masterValues.length === 1) return { ...common, status: 'master_confirmed', candidates: [
    { process_type: masterValues[0], count: 1, share_percent: 100, quote_ids: [], source: 'product_master' }
  ], requires_human_confirmation: false,
  next_action: '商品マスタの確定済み加工種別を使用できます。マスタ行と品番を画面で確認してください。' };
  if (!selectedCustomer?.logical_key || !selectedProduct?.logical_key || !compact(query.material)
    || !Number.isFinite(Number(query.quantity)) || Number(query.quantity) <= 0) {
    return { ...common, status: 'input_incomplete',
      next_action: '顧客・商品・材質・数量が揃わないため候補を絞れません。技術担当へ確認してください。' };
  }
  const customerKey = selectedCustomer.logical_key;
  const productKey = selectedProduct.logical_key;
  const material = compact(query.material);
  const quantity = Number(query.quantity);
  const matched = rows.filter(row => normalizeCustomerName(row.customer_name) === customerKey
    && normalizeProductCode(row.product_code) === productKey && compact(row.material) === material
    && Number(row.quantity) === quantity && text(row.process_type));
  const grouped = new Map();
  for (const row of matched) {
    const key = compact(row.process_type);
    if (!grouped.has(key)) grouped.set(key, { process_type: text(row.process_type), rows: [] });
    grouped.get(key).rows.push(row);
  }
  const candidates = [...grouped.values()].map(groupedItem => ({
    process_type: groupedItem.process_type,
    count: groupedItem.rows.length,
    share_percent: matched.length ? Math.round((groupedItem.rows.length / matched.length) * 10_000) / 100 : 0,
    quote_ids: groupedItem.rows.map(row => row.quote_no),
    latest_quote_date: groupedItem.rows.map(row => String(row.quote_date)).sort().reverse()[0] || null,
    source: 'past_history'
  })).sort((a, b) => b.count - a.count || String(b.latest_quote_date).localeCompare(String(a.latest_quote_date))
    || a.process_type.localeCompare(b.process_type, 'ja'));
  const single = candidates.length === 1 && candidates[0].count >= 2;
  if (single) return { ...common, status: 'single_candidate', candidates,
    next_action: `過去実績${candidates[0].count}件がすべて「${candidates[0].process_type}」です。営業が根拠を確認してから採用してください。` };
  if (!candidates.length) return { ...common, status: 'no_candidate', candidates,
    next_action: '同一顧客・品番・材質・数量の過去実績がありません。加工種別を推測せず技術担当へ確認してください。' };
  return { ...common, status: 'multiple_candidates', candidates,
    next_action: '過去実績に複数の加工種別があります。営業やAIで選ばず、技術担当が加工種別を確定してください。' };
}

export function validateProcessTypeDecision(value, suggestion) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['source','value','confirmed','confirmed_by','basis'].includes(key)))
    throw new ExtractionError('PROCESS_TYPE_CONFIRMATION_REQUIRED', '加工種別の確定経路を記録してください。');
  const source = text(value.source), processType = text(value.value), confirmedBy = text(value.confirmed_by), basis = text(value.basis);
  if (!['product_master','past_history','technical_confirmed','technical_required'].includes(source)
    || typeof value.confirmed !== 'boolean' || !basis || basis.length > 1000 || confirmedBy.length > 100)
    throw new ExtractionError('PROCESS_TYPE_DECISION_INVALID', '加工種別の値、確認者、根拠、確定状態を確認してください。');
  if (source === 'product_master') {
    if (suggestion.status !== 'master_confirmed' || processType !== suggestion.master.value || value.confirmed !== true)
      throw new ExtractionError('PROCESS_TYPE_MASTER_INVALID', '商品マスタに確定済みの加工種別がありません。');
  } else if (source === 'past_history') {
    if (suggestion.status !== 'single_candidate' || processType !== suggestion.candidates[0]?.process_type
      || value.confirmed !== true || !confirmedBy)
      throw new ExtractionError('PROCESS_TYPE_HISTORY_INVALID', '一意な過去実績候補を営業が確認した記録が必要です。');
  } else if (source === 'technical_confirmed') {
    if (!processType || value.confirmed !== true || !confirmedBy)
      throw new ExtractionError('PROCESS_TYPE_TECH_INVALID', '技術担当が確定した加工種別、確認者、根拠を入力してください。');
  } else if (processType || value.confirmed !== false || !confirmedBy) {
    throw new ExtractionError('PROCESS_TYPE_ROUTE_INVALID', '未確定として技術確認へ回す場合は、加工種別を空欄にし、記録者と理由を入力してください。');
  }
  return { source, value: processType || null, confirmed: value.confirmed, confirmed_by: confirmedBy || null,
    basis, rule_version: PROCESS_TYPE_RULE_VERSION, recorded_at: new Date().toISOString(), final_decision_by_ai: false };
}

const PRICE_LEVELS = Object.freeze(['none', 'attention', 'warning', 'stop']);
const PRICE_LEVEL_LABELS = Object.freeze({ none: '通常', attention: '注意', warning: '警告', stop: '停止' });
const COMPARABLE_FIELDS = Object.freeze(['product_code', 'customer_name', 'material', 'quantity', 'process_type']);
const NOTE_RULES = Object.freeze([
  { id: 'non_reusable', pattern: /(前回|今回|この回|今案件)[^\s、。]*(限り|限定)|(限り|限定)[^\s、。]*(前回|今回|この回|今案件)/u, mode: 'minimum', level: 'stop', reason: '今回・前回限りの条件' },
  { id: 'special_pricing', pattern: /特別値引|戦略価格|顧客別条件|特別価格/u, mode: 'minimum', level: 'warning', reason: '特別価格・顧客別条件' },
  { id: 'material_cost', pattern: /材料高騰|原料高騰|原価改定|材料費改定|原料価格/u, mode: 'raise_one', reason: '材料・原価の変動' },
  { id: 'urgent_premium', pattern: /緊急対応|短納期加算|特急|急ぎ/u, mode: 'raise_one', reason: '緊急・短納期条件' }
]);

function quoteDifference(quote, field) {
  return quote.differences?.find(item => item.field === field);
}
function levelIndex(level) { return PRICE_LEVELS.indexOf(level); }
function maximumLevel(left, right) { return levelIndex(left) >= levelIndex(right) ? left : right; }
function raiseLevel(level) { return PRICE_LEVELS[Math.min(PRICE_LEVELS.length - 1, levelIndex(level) + 1)]; }
function numericLevel(percent, thresholds) {
  if (percent >= thresholds.stop_percent) return 'stop';
  if (percent >= thresholds.warning_percent) return 'warning';
  if (percent >= thresholds.attention_percent) return 'attention';
  return 'none';
}
function noteAssessment(notes, baseLevel) {
  const textValue = notes.filter(Boolean).join(' / ');
  if (!textValue) return { level: baseLevel, matched_rules: [], unclassified_notes: [] };
  let level = baseLevel;
  const matchedRules = [];
  for (const rule of NOTE_RULES) {
    if (!rule.pattern.test(textValue)) continue;
    matchedRules.push({ id: rule.id, reason: rule.reason, mode: rule.mode, level: rule.level ?? null });
    level = rule.mode === 'raise_one' ? raiseLevel(level) : maximumLevel(level, rule.level);
  }
  const unclassified = matchedRules.length ? [] : notes.filter(Boolean);
  if (unclassified.length) level = maximumLevel(level, 'attention');
  return { level, matched_rules: matchedRules, unclassified_notes: unclassified };
}
function amountText(value) { return Number(value).toLocaleString('ja-JP'); }

export function analyzeQuotePrices(quotes, thresholds = PRICE_DIFFERENCE_THRESHOLDS) {
  const definition = { source_field: 'quote_price', amount_type: 'unspecified', currency: 'unspecified', tax_treatment: 'unspecified',
    comparison_assumption: 'course_dataset_provisional',
    note: '配布CSVに単価／総額、通貨、税区分の定義がないため、課題用データ内の原値を暫定比較します。実業務への価格転用は禁止です。' };
  const candidates = quotes.map(quote => {
    const price = Number(quoteDifference(quote, 'quote_price')?.past_value);
    const date = String(quoteDifference(quote, 'quote_date')?.past_value ?? '');
    const note = quoteDifference(quote, 'note')?.past_value ?? null;
    const failedFields = COMPARABLE_FIELDS.filter(field => quoteDifference(quote, field)?.status !== 'same');
    return { quote_id: quote.quote_id, price, quote_date: date, note, failed_fields: failedFields,
      comparable: Number.isFinite(price) && price > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && failedFields.length === 0 };
  });
  const comparable = candidates.filter(candidate => candidate.comparable)
    .sort((a, b) => b.quote_date.localeCompare(a.quote_date) || a.quote_id.localeCompare(b.quote_id));
  const responsibilities = {
    attention: '営業が見積日・注記・顧客条件を確認し、採用・却下理由を記録する。',
    warning: '営業と技術担当が材質・加工種別・図面版・現在原価を確認し、採用・却下理由を記録する。',
    stop: '営業責任者が承認するまで価格確定と顧客送信を停止する。検索結果は確認のため表示する。'
  };
  const common = { rule_version: PRICE_DIFFERENCE_RULE_VERSION, thresholds_percent: thresholds, definition,
    required_comparable_fields: COMPARABLE_FIELDS, candidate_count: candidates.length, comparable_count: comparable.length,
    search_results_visible: true, responsibilities };
  if (comparable.length < 2) {
    const failed = [...new Set(candidates.flatMap(candidate => candidate.failed_fields))];
    return { ...common, status: 'comparison_unavailable', severity: 'stop', baseline: comparable[0] ?? null, comparisons: [],
      adoption_blocked: true, failed_comparable_fields: failed,
      confirmation_items: ['同一の顧客・品番・材質・数量・加工種別であるか', '金額が単価か総額か、通貨、税区分', '図面・仕様の版'],
      message: `比較可能な過去見積が${comparable.length}件のため価格差を判定できません。顧客・品番・材質・数量・加工種別と金額定義を確認し、価格転用を停止してください。` };
  }
  const baseline = comparable[0];
  const comparisons = comparable.slice(1).map(candidate => {
    const signedAmount = candidate.price - baseline.price;
    const differenceAmount = Math.abs(signedAmount);
    const differencePercent = Math.round((differenceAmount / baseline.price) * 10000) / 100;
    const baseLevel = numericLevel(differencePercent, thresholds);
    const notes = [baseline.note, candidate.note].filter(Boolean);
    const noteResult = noteAssessment(notes, baseLevel);
    return { quote_id: candidate.quote_id, quote_date: candidate.quote_date, price: candidate.price,
      baseline_quote_id: baseline.quote_id, baseline_quote_date: baseline.quote_date, baseline_price: baseline.price,
      difference_amount: differenceAmount, signed_difference_amount: signedAmount, difference_percent: differencePercent,
      numeric_severity: baseLevel, severity: noteResult.level, notes,
      note_rules: noteResult.matched_rules, unclassified_notes: noteResult.unclassified_notes };
  });
  const overall = comparisons.reduce((result, comparison) => levelIndex(comparison.severity) > levelIndex(result.severity) ? comparison : result, comparisons[0]);
  const severity = overall.severity;
  const noteReason = overall.note_rules.length
    ? `注記「${overall.notes.join(' / ')}」が${overall.note_rules.map(rule => rule.reason).join('・')}に該当するため${PRICE_LEVEL_LABELS[severity]}にしました。`
    : overall.unclassified_notes.length ? `未分類の注記「${overall.unclassified_notes.join(' / ')}」があるため人間の確認が必要です。` : '';
  const confirmationItems = ['現在の材料原価と過去注記の適用時期', '数量・材質・加工種別・図面版の一致', '特別値引・顧客別条件', '金額の単価／総額・通貨・税区分'];
  const message = severity === 'none'
    ? `基準${baseline.quote_id}の過去見積金額${amountText(baseline.price)}と${overall.quote_id}の差は${amountText(overall.difference_amount)}（基準比${overall.difference_percent}%）で、注意閾値${thresholds.attention_percent}%未満かつ重要注記はありません。検索結果は通常表示します。`
    : `価格差異${PRICE_LEVEL_LABELS[severity]}：基準${baseline.quote_id}の過去見積金額${amountText(baseline.price)}と${overall.quote_id}の差は${amountText(overall.difference_amount)}（基準比${overall.difference_percent}%）です。${noteReason}確認事項：${confirmationItems.join('、')}。${responsibilities[severity]}`;
  return { ...common, status: severity === 'none' ? 'within_threshold' : 'alert', severity, baseline,
    comparisons, highest_risk_comparison: overall, adoption_blocked: severity === 'stop', failed_comparable_fields: [],
    confirmation_items: confirmationItems, message };
}

export function validateSearchInput(record, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['revision', 'values', 'acknowledged'].includes(key))
    || !Number.isInteger(body.revision) || body.revision !== record.revision || body.acknowledged !== true)
    throw new ExtractionError('SEARCH_INPUT_INVALID', '最新の抽出結果と検索条件を確認してください。');
  if (record.output_payload.status === 'error' || record.output_payload.warnings_and_holds.some(w => stopCodes.has(w.code)))
    throw new ExtractionError('SEARCH_HELD', '対象外・商品数不明・エラーの依頼は類似検索へ進めません。', 409);
  if (!['規格品', '類似品'].includes(record.input_payload.case_type) || record.input_payload.item_scope !== 'single')
    throw new ExtractionError('SEARCH_OUT_OF_MVP', '規格品・類似品かつ1依頼1商品の案件だけが対象です。', 409);
  const allowed = ['customer_name', 'product_name', 'product_code', 'material', 'process_type', 'quantity', 'quantity_unit', 'dimensions', 'tolerance', 'requested_delivery_date'];
  if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values) || Object.keys(body.values).some(k => !allowed.includes(k))
    || allowed.some(k => !Object.hasOwn(body.values, k))) throw new ExtractionError('SEARCH_FIELDS_INVALID', '検索条件の項目が一致しません。');
  const values = structuredClone(body.values);
  for (const key of allowed) {
    const value = values[key];
    if (value === '') values[key] = null;
    else if (value !== null && key === 'quantity') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new ExtractionError('SEARCH_VALUE_INVALID', '数量は0より大きい数値にしてください。');
    } else if (value !== null && (typeof value !== 'string' || value.length > 1000)) throw new ExtractionError('SEARCH_VALUE_INVALID', '検索条件の文字数・形式を確認してください。');
  }
  if (!text(values.customer_name) || (!text(values.product_code) && !text(values.product_name)))
    throw new ExtractionError('SEARCH_KEYS_MISSING', '顧客名と、品番または品名が必要です。');
  return values;
}

export function newSearchRunId() { return randomUUID(); }
