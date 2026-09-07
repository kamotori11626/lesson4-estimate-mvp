import { auditIdentity } from './request-context.mjs';

export function createApprovalEmailStore(pool) {
  async function transaction(action) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const value = await action(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const event = (client, runId, type, summary) => client.query(
    'INSERT INTO approval_email_events(run_id,event_type,event_summary) VALUES($1,$2,$3)', [runId, type, summary]);
  return {
    async create(run) {
      await transaction(async client => {
        await client.query(`INSERT INTO approval_email_runs
          (run_id,extraction_run_id,request_id,similar_search_run_id,input_payload,approval_result,rule_version,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [run.run_id, run.extraction_run_id, run.request_id,
          run.similar_search_run_id, run.input, run.approval, run.approval.rule_version, run.approval.status]);
        await event(client, run.run_id, 'approval_evaluated', { status: run.approval.status,
          rule_version: run.approval.rule_version, decisive_rule_ids: run.approval.rule_results.filter(r => r.outcome === run.approval.status).map(r => r.rule_id),
          execution: 'local_deterministic_rules', external_ai_calls: 0, ...auditIdentity() });
      });
    },
    async get(runId) {
      const { rows } = await pool.query('SELECT * FROM approval_email_runs WHERE run_id=$1', [runId]);
      return rows[0] || null;
    },
    async latest(extractionId) {
      const { rows } = await pool.query('SELECT * FROM approval_email_runs WHERE extraction_run_id=$1 ORDER BY created_at DESC LIMIT 1', [extractionId]);
      return rows[0] || null;
    },
    async saveDraft(runId, draft) {
      return transaction(async client => {
        const { rows } = await client.query(`INSERT INTO approval_email_drafts
          (draft_id,run_id,draft_type,recipient_role,generation_method,model,prompt_version,external_preview,generation_input,draft_payload,quality_result,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [draft.draft_id, runId, draft.draft_type,
          draft.recipient_role, draft.generation_method, draft.model, draft.prompt_version, draft.external_preview,
          draft.generation_input, draft.payload, draft.quality, draft.status]);
        await event(client, runId, 'draft_created', { draft_id: draft.draft_id, draft_type: draft.draft_type,
          generation_method: draft.generation_method, model: draft.model, external_ai_calls: draft.external_ai_calls,
          quality_passed: draft.quality.passed, auto_send: false, ...auditIdentity() });
        return rows[0];
      });
    },
    async getDraft(runId, draftId) {
      const { rows } = await pool.query('SELECT * FROM approval_email_drafts WHERE run_id=$1 AND draft_id=$2', [runId, draftId]);
      return rows[0] || null;
    },
    async saveDraftReview(runId, draftId, review) {
      return transaction(async client => {
        const { rows } = await client.query(`UPDATE approval_email_drafts SET subject=$3,body=$4,human_review=$5,status=$6,quality_result=$7,updated_at=now(),revision=revision+1
          WHERE draft_id=$1 AND run_id=$2 RETURNING *`, [draftId, runId, review.subject, review.body, review, review.decision, review.quality]);
        if (!rows.length) return null;
        await event(client, runId, 'draft_human_review_saved', { draft_id: draftId, decision: review.decision,
          reason: review.reason, ...auditIdentity(), auto_send: false });
        return rows[0];
      });
    },
    async drafts(runId) {
      const { rows } = await pool.query('SELECT * FROM approval_email_drafts WHERE run_id=$1 ORDER BY created_at DESC', [runId]);
      return rows;
    }
  };
}
