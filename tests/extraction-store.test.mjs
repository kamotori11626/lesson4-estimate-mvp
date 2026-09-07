import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtractionStore } from '../src/extraction-store.mjs';

function databaseStub({ stale = false, failHistory = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('UPDATE extraction_runs')) return { rows: stale ? [] : [{ revision: 2 }] };
      if (sql.startsWith('INSERT INTO extraction_review_drafts')) {
        // pg treats a raw JS array as a PostgreSQL array, not a JSON array.
        // Require explicit JSON serialization at the store/driver boundary.
        assert.equal(typeof params[2], 'string');
        assert.ok(Array.isArray(JSON.parse(params[2])));
        if (failHistory) throw new Error('history write failed');
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  return { calls, store: createExtractionStore({ connect: async () => client }) };
}

for (const [name, changes] of [
  ['変更なし', []],
  ['数量の変更', [{ field_name: 'quantity', before: 1, after: 2 }]],
  ['複数項目・null・引用符・日本語', [
    { field_name: 'material', before: null, after: 'SUS304' },
    { field_name: 'product_name', before: '商品A', after: '検証用「商品」 "B"\\C\n改行' }
  ]]
]) {
  test(`修正履歴をJSON配列として保存する：${name}`, async () => {
    const { store, calls } = databaseStub();
    const original = structuredClone(changes);
    assert.equal(await store.saveReview('test-run', 1, { status: 'needs_review' }, changes), 2);
    const history = calls.find(c => c.sql.startsWith('INSERT INTO extraction_review_drafts'));
    assert.deepEqual(JSON.parse(history.params[2]), original);
    assert.deepEqual(changes, original);
    const event = calls.find(c => c.sql.startsWith('INSERT INTO extraction_events'));
    assert.deepEqual(event.params[2].changed_fields, changes.map(c => c.field_name));
    assert.deepEqual(calls.slice(-2).map(c => c.sql), ['COMMIT', 'RELEASE']);
  });
}

test('履歴保存に失敗した場合は結果更新もロールバックする', async () => {
  const { store, calls } = databaseStub({ failHistory: true });
  await assert.rejects(store.saveReview('test-run', 1, {}, [{ field_name: 'quantity', before: 1, after: 2 }]), /history write failed/);
  assert.deepEqual(calls.slice(-2).map(c => c.sql), ['ROLLBACK', 'RELEASE']);
  assert.ok(!calls.some(c => c.sql === 'COMMIT' || c.sql.startsWith('INSERT INTO extraction_events')));
});

test('古い版からの保存は履歴を追加せずに拒否する', async () => {
  const { store, calls } = databaseStub({ stale: true });
  assert.equal(await store.saveReview('test-run', 0, {}, []), null);
  assert.ok(!calls.some(c => c.sql.startsWith('INSERT')));
});

test('回答・確認状態・期間は値の変更と同一トランザクションに保存する', async () => {
  const { store, calls } = databaseStub();
  const business = { version: 'business-review-1.0', answers: [{ text: '架空回答' }], delivery: { kind: 'window', start: '2026-09-02', end: '2026-09-04' } };
  await store.saveReview('test-run', 1, {}, [], business);
  assert.deepEqual(calls.find(c => c.sql.startsWith('UPDATE')).params[3], business);
  assert.deepEqual(calls.find(c => c.sql.startsWith('INSERT INTO extraction_review_drafts')).params[3], business);
  assert.ok(!calls.find(c => c.sql.startsWith('UPDATE')).sql.includes('initial_output='));
});
