#!/usr/bin/env node
/**
 * scripts/hash-password.mjs
 *
 * Generate a bcrypt hash for the fallback admin password. Run locally, copy
 * the output, paste into Vercel → Settings → Environment Variables as
 * ADMIN_FALLBACK_PASSWORD_HASH.
 *
 * Usage:
 *   node scripts/hash-password.mjs
 *   → prompts for password (hidden input)
 *
 * Or pipe it:
 *   echo 'MySecret!' | node scripts/hash-password.mjs
 *
 * Requires: npm install bcryptjs  (run once at project root).
 */

import bcrypt from 'bcryptjs';
import readline from 'node:readline';

const ROUNDS = 10;

function readPasswordInteractive() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('Password: ');
    // Suppress echo
    const origWrite = process.stdout.write.bind(process.stdout);
    const stdin = process.stdin;
    const origOn = stdin.on.bind(stdin);
    let captured = '';
    stdin.setRawMode && stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const handler = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        stdin.setRawMode && stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', handler);
        origWrite('\n');
        rl.close();
        resolve(captured);
      } else if (ch === '\u0003') {
        // Ctrl-C
        process.exit(1);
      } else if (ch === '\b' || ch === '\x7f') {
        captured = captured.slice(0, -1);
      } else {
        captured += ch;
      }
    };
    stdin.on('data', handler);
  });
}

function readPasswordPiped() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
  });
}

async function main() {
  const isTty = process.stdin.isTTY;
  const pw = isTty ? await readPasswordInteractive() : await readPasswordPiped();
  if (!pw) {
    console.error('No password supplied');
    process.exit(1);
  }
  if (pw.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }
  const hash = await bcrypt.hash(pw, ROUNDS);
  console.log('');
  console.log('Bcrypt hash (set as ADMIN_FALLBACK_PASSWORD_HASH in Vercel):');
  console.log('');
  console.log(hash);
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
