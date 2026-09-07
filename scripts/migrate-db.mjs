import { pool } from '../src/db.mjs';
import { migrateDatabase } from '../src/migrate.mjs';

try {
  const files = await migrateDatabase(pool);
  console.log(`DB migration completed (${files.length} files).`);
} finally { await pool.end(); }
