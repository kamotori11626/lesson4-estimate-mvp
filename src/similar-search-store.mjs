import { auditIdentity } from './request-context.mjs';

export function createSimilarSearchStore(pool) {
  async function transaction(action) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const event = (client, runId, type, summary) => client.query(
    'INSERT INTO similar_search_events(run_id,event_type,event_summary) VALUES($1,$2,$3)', [runId, type, summary]);
  return {
    async data() {
      const [customers, products, quotes, snapshot] = await Promise.all([
        pool.query('SELECT customer_id,customer_name,billing_name,delivery_site,sales_rep FROM customer_master_raw ORDER BY source_row_no'),
        pool.query('SELECT product_id,product_code,product_name,material,unit,discontinued_flag,note FROM product_master_raw ORDER BY source_row_no'),
        pool.query('SELECT quote_no,quote_date,customer_name,product_code,material,process_type,quantity,quote_price,gross_margin_rate,approved_by,approval_reason,note,drawing_link FROM past_quote_raw ORDER BY source_row_no'),
        pool.query("SELECT coalesce(max(completed_at),now()) AS data_as_of FROM import_runs WHERE source_name IN ('19_顧客マスタ.csv','20_商品マスタ.csv','18_過去見積履歴.csv') AND status='completed'")
      ]);
      const dataAsOf = snapshot.rows[0].data_as_of;
      return { customers: customers.rows, products: products.rows, quotes: quotes.rows,
        data_as_of: dataAsOf instanceof Date ? dataAsOf.toISOString() : String(dataAsOf) };
    },
    async create(run) {
      await transaction(async client => {
        await client.query(`INSERT INTO similar_search_runs
          (run_id,extraction_run_id,request_id,extraction_revision,input_payload,entity_candidates,status,rule_version,data_as_of)
          VALUES($1,$2,$3,$4,$5,$6,'entity_review',$7,$8)`,
        [run.run_id, run.extraction_run_id, run.request_id, run.extraction_revision, run.input,
          run.entity_candidates, run.rule_version, run.data_as_of]);
        await event(client, run.run_id, 'entity_candidates_created', { customer_candidates: run.entity_candidates.customers.length,
          product_candidates: run.entity_candidates.products.length, rule_version: run.rule_version, data_as_of: run.data_as_of,
          external_ai_calls: 0, ...auditIdentity() });
      });
    },
    async get(runId) {
      const { rows } = await pool.query('SELECT * FROM similar_search_runs WHERE run_id=$1', [runId]);
      return rows[0] || null;
    },
    async latest(extractionRunId) {
      const { rows } = await pool.query('SELECT * FROM similar_search_runs WHERE extraction_run_id=$1 ORDER BY created_at DESC LIMIT 1', [extractionRunId]);
      return rows[0] || null;
    },
    async saveQuotes(runId, revision, customer, product, quotes, input, processTypeDecision) {
      return transaction(async client => {
        const { rows } = await client.query(`UPDATE similar_search_runs SET selected_customer=$3,selected_product=$4,
          similar_quotes=$5::jsonb,input_payload=$6::jsonb,
          entity_candidates=jsonb_set(entity_candidates,'{process_type_decision}',$7::jsonb,true),
          decision=NULL,status='quote_review',updated_at=now(),revision=revision+1 WHERE run_id=$1 AND revision=$2 RETURNING revision`,
        [runId, revision, customer, product, JSON.stringify(quotes), input, processTypeDecision]);
        if (!rows.length) return null;
        await event(client, runId, 'similar_quotes_created', { selected_customer_candidate_id: customer?.candidate_id || null,
          selected_product_candidate_id: product.candidate_id, quote_count: quotes.length,
          process_type_decision: processTypeDecision, external_ai_calls: 0, ...auditIdentity() });
        return rows[0].revision;
      });
    },
    async saveDecision(runId, revision, decision) {
      return transaction(async client => {
        const { rows } = await client.query(`UPDATE similar_search_runs SET decision=$3,status='reviewed',updated_at=now(),revision=revision+1
          WHERE run_id=$1 AND revision=$2 RETURNING revision`, [runId, revision, decision]);
        if (!rows.length) return null;
        await event(client, runId, 'human_decision_saved', { ...decision, ...auditIdentity() });
        return rows[0].revision;
      });
    }
  };
}
