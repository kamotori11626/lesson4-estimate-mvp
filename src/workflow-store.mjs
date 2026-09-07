export function createWorkflowStore(pool) {
  return {
    async get(extractionId) {
      const extractionResult = await pool.query(
        `SELECT run_id,request_id,created_at,updated_at,input_payload,output_payload,initial_output,
                business_review,execution,revision
           FROM extraction_runs WHERE run_id=$1`, [extractionId]);
      const extraction = extractionResult.rows[0] || null;
      if (!extraction) return null;

      const searchResult = await pool.query(
        `SELECT * FROM similar_search_runs
          WHERE extraction_run_id=$1 ORDER BY created_at DESC LIMIT 1`, [extractionId]);
      const search = searchResult.rows[0] || null;
      const approvalResult = await pool.query(
        `SELECT * FROM approval_email_runs
          WHERE extraction_run_id=$1 ORDER BY created_at DESC LIMIT 1`, [extractionId]);
      const approval = approvalResult.rows[0] || null;
      const drafts = approval ? (await pool.query(
        `SELECT * FROM approval_email_drafts WHERE run_id=$1 ORDER BY created_at DESC`, [approval.run_id])).rows : [];

      const extractionEvents = (await pool.query(
        `SELECT occurred_at,event_type,event_summary FROM extraction_events
          WHERE run_id=$1 ORDER BY occurred_at,id`, [extractionId])).rows;
      const searchEvents = search ? (await pool.query(
        `SELECT occurred_at,event_type,event_summary FROM similar_search_events
          WHERE run_id=$1 ORDER BY occurred_at,id`, [search.run_id])).rows : [];
      const approvalEvents = approval ? (await pool.query(
        `SELECT occurred_at,event_type,event_summary FROM approval_email_events
          WHERE run_id=$1 ORDER BY occurred_at,id`, [approval.run_id])).rows : [];

      return { extraction, search, approval, drafts, events: {
        extraction: extractionEvents, similar_search: searchEvents, approval_email: approvalEvents
      } };
    }
  };
}
