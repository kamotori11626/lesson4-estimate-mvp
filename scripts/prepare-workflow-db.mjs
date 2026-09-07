import fs from 'node:fs/promises';
import { pool } from '../src/db.mjs';

let client;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query(await fs.readFile(new URL('../db/workflow.sql', import.meta.url), 'utf8'));
  await client.query('COMMIT');
  console.log('統合ワークフローの受け渡し記録用項目を追加しました。既存データは変更していません。');
} catch {
  if (client) await client.query('ROLLBACK');
  console.error('統合ワークフロー用項目の準備に失敗しました。DB起動状態と既存機能用テーブルを確認してください。');
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
