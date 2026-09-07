import fs from 'node:fs/promises';
import path from 'node:path';
import { projectDir } from './config.mjs';

export const MIGRATIONS = Object.freeze(['schema.sql','extraction.sql','approval-email.sql','workflow.sql','auth-demo.sql']);

export async function migrateDatabase(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(417315327)');
    for (const file of MIGRATIONS) await client.query(await fs.readFile(path.join(projectDir, 'db', file), 'utf8'));
  } finally {
    await client.query('SELECT pg_advisory_unlock(417315327)').catch(() => {});
    client.release();
  }
  return MIGRATIONS;
}
