import { ExtractionError } from './extraction.mjs';

export const APPROVAL_SCHEMA_VERSION = 'approval-email-1.0';
export const APPROVAL_RULE_VERSION = 'approval-rules-0.2-draft';
export const RULE_POLICY = Object.freeze({
  gross_margin: {
    below_18: 'required',
    from_18_below_20: 'hold',
    at_least_20: 'no_trigger',
    owner: '顧客企業の業務責任者',
    status: '暫定。見積承認ルール.pdf（20%未満）と営業部運用メモ.docx（18%未満）の矛盾解消待ち'
  },
  discount: {
    zero: 'no_trigger',
    positive: 'hold',
    owner: '顧客企業の業務責任者',
    status: '暫定。正式な値引率閾値・顧客別例外ルールの決定待ち'
  }
});

const allowed = new Set(['planned_price', 'cost', 'list_price', 'required_tech_review',
  'required_supplier_quote', 'route_basis', 'acknowledged']);

function money(value, label, { allowZero = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)
    || (allowZero ? value < 0 : value <= 0) || value > 1_000_000_000)
    throw new ExtractionError('APPROVAL_INPUT_INVALID', `${label}は${allowZero ? '0以上' : '1以上'}の整数（円）で入力してください。`);
  return value;
}

export function validateApprovalInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))
    || body.acknowledged !== true || typeof body.required_tech_review !== 'boolean'
    || typeof body.required_supplier_quote !== 'boolean')
    throw new ExtractionError('APPROVAL_INPUT_INVALID', '判定条件と確認チェックを見直してください。');
  const input = {
    planned_price: money(body.planned_price, '予定見積金額'),
    cost: money(body.cost, '原価', { allowZero: true }),
    list_price: money(body.list_price, '基準価格'),
    required_tech_review: body.required_tech_review,
    required_supplier_quote: body.required_supplier_quote,
    route_basis: typeof body.route_basis === 'string' ? body.route_basis.trim() : '',
    acknowledged: true
  };
  if (input.route_basis.length > 1000) throw new ExtractionError('APPROVAL_INPUT_INVALID', '技術・外注確認の根拠は1000文字以内で入力してください。');
  if ((input.required_tech_review || input.required_supplier_quote) && !input.route_basis)
    throw new ExtractionError('APPROVAL_INPUT_INVALID', '技術確認・外注見積が必要な理由を入力してください。');
  return input;
}

function rate(numerator, denominator) {
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function result(rule_id, matched, outcome, reason, approver_role = null) {
  return { rule_id, matched, outcome, reason, approver_role };
}

const APPROVER_ROLE_PRIORITY = Object.freeze([
  '管理職',
  '技術担当',
  '購買・外注担当',
  '業務責任者'
]);

function actionableApproverRoles(rules) {
  const roles = [...new Set(rules
    .filter(rule => ['hold', 'required'].includes(rule.outcome))
    .map(rule => rule.approver_role)
    .filter(Boolean))];
  return roles.sort((left, right) => {
    const leftIndex = APPROVER_ROLE_PRIORITY.indexOf(left);
    const rightIndex = APPROVER_ROLE_PRIORITY.indexOf(right);
    const leftRank = leftIndex === -1 ? APPROVER_ROLE_PRIORITY.length : leftIndex;
    const rightRank = rightIndex === -1 ? APPROVER_ROLE_PRIORITY.length : rightIndex;
    return leftRank - rightRank || left.localeCompare(right, 'ja');
  });
}

export function evaluateApproval({ extraction, priceAnalysis = null, rawInput }) {
  const input = validateApprovalInput(rawInput);
  const gross = input.planned_price !== null && input.cost !== null
    ? rate(input.planned_price - input.cost, input.planned_price) : null;
  const discount = input.planned_price !== null && input.list_price !== null
    ? rate(input.list_price - input.planned_price, input.list_price) : null;
  const calculated = { gross_margin_rate: gross, discount_rate: discount };
  const rules = [];
  const stopped = extraction.output_payload?.warnings_and_holds?.some(w =>
    ['MULTIPLE_ITEMS', 'OUT_OF_MVP', 'OUT_OF_SCOPE', 'ITEM_COUNT_UNCERTAIN', 'SCOPE_UNCERTAIN'].includes(w.code));
  const missing = extraction.output_payload?.missing_fields || [];
  const caseType = extraction.input_payload?.case_type || null;

  if (stopped || extraction.output_payload?.status === 'error')
    rules.push(result('SCOPE-001', true, 'hold', '抽出段階で依頼全体が対象外・保留・エラーです。承認判定へ進めません。'));
  if (caseType === '新規特注' || caseType === '緊急')
    rules.push(result('SCOPE-002', true, 'hold', `${caseType}は現在のMVP対象外です。既存の手動手順へ戻してください。`));
  if (!Number.isInteger(extraction.revision) || extraction.revision <= 1)
    rules.push(result('REVIEW-001', true, 'hold', '抽出結果の原文照合・修正下書きがまだ保存されていません。人間が確認してから再判定してください。'));
  if (missing.length)
    rules.push(result('DATA-001', true, 'hold', `未確定項目が${missing.length}件あります。情報を確認してから再判定してください。`));
  if (priceAnalysis?.status === 'not_executed_process_type')
    rules.push(result('PROCESS-001', true, 'hold', '加工種別が未確定のため価格比較を実行していません。技術担当が加工種別と根拠を確定してください。', '技術担当'));
  else if (priceAnalysis?.status === 'comparison_unavailable' || priceAnalysis?.severity === 'stop')
    rules.push(result('PRICE-001', true, 'hold', `過去価格の比較結果が「${priceAnalysis.status === 'comparison_unavailable' ? '比較不能' : '停止'}」です。価格を転用せず管理職が確認してください。`, '管理職'));

  if (gross === null) rules.push(result('GM-000', true, 'hold', '予定見積金額と原価が揃わず、粗利率を再計算できません。'));
  else if (gross < 0 || gross > 100) rules.push(result('GM-INVALID', true, 'hold', `再計算した粗利率${gross}%が仕様範囲（0〜100%）外です。入力値を確認してください。`));
  else if (gross < 18) rules.push(result('GM-018', true, 'required', `再計算した粗利率${gross}%が暫定必須条件の18%未満です。管理職承認が必要です。`, '管理職'));
  else if (gross < 20) rules.push(result('GM-018-020', true, 'hold', `再計算した粗利率${gross}%は、矛盾する18%・20%ルールの間です。業務責任者が正式ルールを決めるまで保留します。`, '業務責任者'));
  else rules.push(result('GM-020', true, 'no_trigger', `再計算した粗利率${gross}%は20%以上のため、粗利率だけでは承認を要求しません。`));

  if (discount === null) rules.push(result('DISC-000', true, 'hold', '予定見積金額と基準価格が揃わず、値引率を再計算できません。'));
  else if (discount < 0 || discount > 100) rules.push(result('DISC-INVALID', true, 'hold', `再計算した値引率${discount}%が仕様範囲（0〜100%）外です。入力値を確認してください。`));
  else if (discount > 0) rules.push(result('DISC-PENDING', true, 'hold', `再計算した値引率${discount}%です。正式な閾値と顧客別例外が未決定のため、自動承認せず業務責任者の確認へ回します。`, '業務責任者'));
  else rules.push(result('DISC-ZERO', true, 'no_trigger', '値引率は0%のため、値引きだけでは承認を要求しません。'));

  if (input.required_tech_review)
    rules.push(result('ROUTE-TECH', true, 'required', `技術確認が必要です。根拠：${input.route_basis}`, '技術担当'));
  if (input.required_supplier_quote)
    rules.push(result('ROUTE-SUPPLIER', true, 'required', `外注見積の確認が必要です。根拠：${input.route_basis}`, '購買・外注担当'));

  const outcome = rules.some(r => r.outcome === 'hold') ? 'hold'
    : rules.some(r => r.outcome === 'required') ? 'required' : 'not_required';
  const decisive = rules.filter(r => r.outcome === outcome);
  return {
    schema_version: APPROVAL_SCHEMA_VERSION,
    rule_version: APPROVAL_RULE_VERSION,
    extraction_revision: extraction.revision,
    status: outcome,
    // 全体結果が hold でも、同時成立した required ルールの確認先を失わない。
    // 例: 加工種別未確定（技術担当）+ 低粗利（管理職）。
    approver_roles: actionableApproverRoles(rules),
    reason: outcome === 'not_required' ? null : decisive.map(r => r.reason).join(' / '),
    input_values: input,
    calculated_values: calculated,
    rule_results: rules,
    policy: RULE_POLICY,
    security: { execution: 'local_deterministic_rules', external_ai_calls: 0, final_decision_by_ai: false }
  };
}
