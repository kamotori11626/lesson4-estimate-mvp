import { createHash } from 'node:crypto';
import { auditIdentity } from './request-context.mjs';

export function createExtractionStore(pool) {
  async function transaction(action) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const value = await action(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const event = (client, id, kind, summary) => client.query(
    'INSERT INTO extraction_events(run_id,event_type,event_summary) VALUES($1,$2,$3)', [id, kind, summary]);
  return {
    async start(id, input, output, execution) {
      await transaction(async client => {
        await client.query('INSERT INTO extraction_runs(run_id,request_id,input_payload,output_payload,execution) VALUES($1,$2,$3,$4,$5)',
          [id, output.request_id, input, output, execution]);
        await event(client, id, 'started', { input_hash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
          input_length: input.request_text.length, execution_user_id: execution.execution_user_id,
          identity_mode: execution.identity_mode, schema_version: output.schema_version });
      });
    },
    async finish(id, output, execution) {
      await transaction(async client => {
        const updated = await client.query('UPDATE extraction_runs SET output_payload=$2,initial_output=COALESCE(initial_output,$2),execution=$3,updated_at=now(),revision=revision+1 WHERE run_id=$1 RETURNING run_id', [id, output, execution]);
        if (updated.rowCount !== 1) throw new Error('Run missing');
        await event(client, id, 'finished', { status: output.status, mode: execution.mode,
          external_attempts: execution.external_attempts, schema_version: output.schema_version,
          model: execution.model, prompt_version: execution.prompt_version, rule_version: execution.rule_version,
          extraction_method: execution.extraction_method, scope_decision: execution.scope_decision,
          warning_codes: output.warnings_and_holds.map(w => w.code), execution_user_id: execution.execution_user_id,
          identity_mode: execution.identity_mode });
      });
    },
    async get(id) {
      const { rows } = await pool.query('SELECT run_id,input_payload,output_payload,initial_output,business_review,execution,revision FROM extraction_runs WHERE run_id=$1', [id]);
      return rows[0] || null;
    },
    async history(id) {
      const { rows } = await pool.query("SELECT id,saved_at,reviewer_id,changes,business_review - 'answers' AS business_review FROM extraction_review_drafts WHERE run_id=$1 ORDER BY id DESC LIMIT 20", [id]);
      return rows;
    },
    async saveReview(id, revision, output, changes, business = null) {
      return transaction(async client => {
        const { rows } = await client.query('UPDATE extraction_runs SET output_payload=$3,business_review=$4,updated_at=now(),revision=revision+1 WHERE run_id=$1 AND revision=$2 RETURNING revision', [id, revision, output, business]);
        if (!rows.length) return null;
        // pg serializes JS arrays as PostgreSQL arrays; encode this JSON array explicitly.
        const identity = auditIdentity();
        await client.query('INSERT INTO extraction_review_drafts(run_id,reviewer_id,changes,business_review) VALUES($1,$2,$3::jsonb,$4)', [id, identity.execution_user_id, JSON.stringify(changes), business]);
        await event(client, id, 'review_draft_saved', { ...identity, changed_fields: changes.map(c => c.field_name), business_version: business?.version || null });
        return rows[0].revision;
      });
    }
  };
}
