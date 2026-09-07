import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimilarSearchStore } from '../src/similar-search-store.mjs';

test('類似案件の配列はJSONとしてDBへ保存する', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (String(sql).includes('UPDATE similar_search_runs')) return { rows: [{ revision: 2 }] };
      return { rows: [] };
    },
    release() {}
  };
  const store = createSimilarSearchStore({ connect: async () => client });
  const quotes = [{ quote_id: 'Q1', similarity_score: 90 }];
  const input = { process_type: '板金' };
  const processTypeDecision = { source: 'technical_confirmed', value: '板金', confirmed: true, confirmed_by: '技術担当', basis: '図面確認' };
  const revision = await store.saveQuotes('run-1', 1, null, { candidate_id: 'product:P1' }, quotes, input, processTypeDecision);
  assert.equal(revision, 2);
  const update = calls.find(call => String(call.sql).includes('UPDATE similar_search_runs'));
  assert.match(update.sql, /\$5::jsonb/);
  assert.match(update.sql, /decision=NULL/);
  assert.equal(update.params[4], JSON.stringify(quotes));
  assert.deepEqual(update.params[5], input);
  assert.deepEqual(update.params[6], processTypeDecision);
});
