import { ExtractionError } from './extraction.mjs';
import { auditIdentity } from './request-context.mjs';
import { analyzeQuotePrices, findCustomerCandidates, findProductCandidates, newSearchRunId, rankPastQuotes,
  SEARCH_RULE_VERSION, SEARCH_SCHEMA_VERSION, suggestProcessTypes, validateProcessTypeDecision, validateSearchInput } from './similar-search.mjs';

function processTypeUnavailable(decision) {
  return { rule_version: decision.rule_version, status: 'not_executed_process_type', severity: 'stop',
    adoption_blocked: true, search_results_visible: false, comparable_count: 0, comparisons: [],
    confirmation_items: ['技術担当が加工種別を確定する', '確定根拠と確認者を記録する'],
    message: `加工種別が未確定のため価格比較を実行していません。技術担当へ確認してください。記録理由：${decision.basis}` };
}

function payload(record) {
  return { schema_version: SEARCH_SCHEMA_VERSION, run_id: record.run_id, extraction_run_id: record.extraction_run_id,
    request_id: record.request_id, extraction_revision: record.extraction_revision,
    status: record.status, revision: record.revision, rule_version: record.rule_version,
    data_as_of: record.data_as_of, input: record.input_payload, entity_candidates: record.entity_candidates,
    selected_customer: record.selected_customer, selected_product: record.selected_product,
    similar_quotes: record.similar_quotes || [], process_type_decision: record.entity_candidates?.process_type_decision || null,
    price_analysis: record.entity_candidates?.process_type_decision?.source === 'technical_required'
      ? processTypeUnavailable(record.entity_candidates.process_type_decision) : analyzeQuotePrices(record.similar_quotes || []), decision: record.decision,
    security: { execution: 'local_postgresql_rules', external_ai_calls: 0, prices_sent_external: false,
      note: '候補検索・価格参照はローカルDB内だけで実行' } };
}

export function createSimilarSearchService({ extractionStore, store }) {
  return {
    async start(extractionId, body) {
      const extraction = await extractionStore.get(extractionId);
      if (!extraction) throw new ExtractionError('NOT_FOUND', '対象の抽出記録がありません。', 404);
      const input = validateSearchInput(extraction, body);
      const data = await store.data();
      const entityCandidates = { customers: findCustomerCandidates(data.customers, input.customer_name),
        products: findProductCandidates(data.products, input) };
      const run = { run_id: newSearchRunId(), extraction_run_id: extractionId, request_id: extraction.output_payload.request_id,
        extraction_revision: extraction.revision, input, entity_candidates: entityCandidates,
        rule_version: SEARCH_RULE_VERSION, data_as_of: data.data_as_of };
      await store.create(run);
      return payload(await store.get(run.run_id));
    },
    async processTypes(runId, body) {
      const record = await store.get(runId);
      if (!record) throw new ExtractionError('SEARCH_NOT_FOUND', '名寄せ検索記録がありません。', 404);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(k => !['revision','customer_candidate_id','product_candidate_id'].includes(k))
        || !Number.isInteger(body.revision) || body.revision !== record.revision)
        throw new ExtractionError('PROCESS_TYPE_SELECTION_INVALID', '最新の顧客・商品候補を選択してください。');
      const customer = body.customer_candidate_id === null ? null
        : record.entity_candidates.customers.find(c => c.candidate_id === body.customer_candidate_id);
      const product = record.entity_candidates.products.find(c => c.candidate_id === body.product_candidate_id);
      if (body.customer_candidate_id !== null && !customer)
        throw new ExtractionError('PROCESS_TYPE_SELECTION_INVALID', '表示中の顧客候補を選択してください。');
      if (!product) throw new ExtractionError('PROCESS_TYPE_SELECTION_INVALID', '商品候補を選択してください。');
      const data = await store.data();
      return { run_id: runId, revision: record.revision,
        suggestion: suggestProcessTypes(data.quotes, record.input_payload, customer, product),
        security: { execution: 'local_postgresql_rules', external_ai_calls: 0, final_decision_by_ai: false } };
    },
    async quotes(runId, body) {
      const record = await store.get(runId);
      if (!record) throw new ExtractionError('SEARCH_NOT_FOUND', '名寄せ検索記録がありません。', 404);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['revision','customer_candidate_id','product_candidate_id','process_type_decision'].includes(k))
        || !Number.isInteger(body.revision) || body.revision !== record.revision)
        throw new ExtractionError('SEARCH_SELECTION_INVALID', '最新の名寄せ候補を選択してください。');
      const customers = record.entity_candidates.customers;
      const products = record.entity_candidates.products;
      const customer = body.customer_candidate_id === null ? null : customers.find(c => c.candidate_id === body.customer_candidate_id);
      const product = products.find(c => c.candidate_id === body.product_candidate_id);
      if (body.customer_candidate_id !== null && !customer) throw new ExtractionError('CUSTOMER_SELECTION_INVALID', '表示中の顧客候補から選択してください。');
      if (!product) throw new ExtractionError('PRODUCT_SELECTION_INVALID', '表示中の商品候補から選択してください。');
      const data = await store.data();
      const suggestion = suggestProcessTypes(data.quotes, record.input_payload, customer, product);
      const processTypeDecision = validateProcessTypeDecision(body.process_type_decision, suggestion);
      const input = { ...record.input_payload, process_type: processTypeDecision.value };
      const quotes = processTypeDecision.source === 'technical_required'
        ? [] : rankPastQuotes(data.quotes, input, customer, product, record.data_as_of);
      const revision = await store.saveQuotes(runId, record.revision, customer, product, quotes, input, processTypeDecision);
      if (revision === null) throw new ExtractionError('STALE_SEARCH', '別の操作で検索結果が更新されました。再表示してください。', 409);
      return payload(await store.get(runId));
    },
    async decide(runId, body) {
      const record = await store.get(runId);
      if (!record) throw new ExtractionError('SEARCH_NOT_FOUND', '類似検索記録がありません。', 404);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['revision','quote_id','decision','reason'].includes(k))
        || !Number.isInteger(body.revision) || body.revision !== record.revision || !['accepted','rejected'].includes(body.decision)
        || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000)
        throw new ExtractionError('QUOTE_DECISION_INVALID', '採用・却下と判断理由を入力してください。');
      if (body.decision === 'accepted' && !record.similar_quotes.some(q => q.quote_id === body.quote_id))
        throw new ExtractionError('QUOTE_SELECTION_INVALID', '表示中の過去見積候補から選択してください。');
      if (body.decision === 'rejected' && body.quote_id !== null && !record.similar_quotes.some(q => q.quote_id === body.quote_id))
        throw new ExtractionError('QUOTE_SELECTION_INVALID', '表示中の候補または候補なしを選択してください。');
      const identity = auditIdentity();
      const decision = { quote_id: body.quote_id ?? null, decision: body.decision, reason: body.reason.trim(),
        reviewer_id: identity.execution_user_id, reviewed_at: new Date().toISOString(), identity_mode: identity.identity_mode,
        note: '認証済み利用者の判断記録です。価格確定または正式承認そのものではありません。' };
      const revision = await store.saveDecision(runId, record.revision, decision);
      if (revision === null) throw new ExtractionError('STALE_SEARCH', '別の操作で検索結果が更新されました。再表示してください。', 409);
      return payload(await store.get(runId));
    },
    async get(runId) {
      const record = await store.get(runId);
      if (!record) throw new ExtractionError('SEARCH_NOT_FOUND', '類似検索記録がありません。', 404);
      return payload(record);
    },
    async latest(extractionId) {
      const record = await store.latest(extractionId);
      return record ? payload(record) : null;
    }
  };
}
