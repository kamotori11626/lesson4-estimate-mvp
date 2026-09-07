import { config, validateRuntimeConfig } from '../src/config.mjs';
import { pool } from '../src/db.mjs';
import { demoCounts, seedDemoData } from '../src/demo-seed.mjs';
import { migrateDatabase } from '../src/migrate.mjs';

validateRuntimeConfig(config);
console.log('startup stage: migrate');
await migrateDatabase(pool);
console.log('startup stage: seed check');
const counts = await demoCounts(pool);
if (Object.values(counts).some(count => Number(count) === 0)) await seedDemoData(pool);
console.log('startup stage: application');
await import('../src/server.mjs');
