import process from 'node:process';
import { hashPassword } from '../src/password.mjs';

if (!process.stdin.isTTY || !process.stdin.setRawMode) {
  console.error('対話型ターミナルで実行してください。');
  process.exit(1);
}

process.stdout.write('デモ用パスワード（12文字以上）: ');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
let password = '';
for await (const chunk of process.stdin) {
  for (const char of chunk) {
    if (char === '\u0003') { process.stdout.write('\n'); process.exit(130); }
    if (char === '\r' || char === '\n') {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      console.log(await hashPassword(password));
      process.exit(0);
    }
    if (char === '\u007f') password = password.slice(0, -1);
    else password += char;
  }
}
