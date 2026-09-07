import { testAi } from '../src/ai.mjs';

// Uses the application's settings without printing the key or raw provider response.
const result = await testAi();
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.verified_external_connection ? 0 : 1;
