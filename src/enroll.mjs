// Pairs an authenticator app with this machine.
//
// Prints the QR in the terminal and nothing else: no window, no port, no
// browser. Whatever the secret is, it exists in this process, in the QR on your
// screen, and in ~/.work-hub/totp.json. It never touches the network - which is
// the entire reason this repo carries its own QR encoder.
//
// The secret is only written after a code from the phone verifies, so a scan
// that silently failed cannot leave the server demanding codes from an app that
// does not have the pairing.

import os from 'node:os';
import process from 'node:process';
import readline from 'node:readline/promises';

import { renderQrToTerminal } from './lib/qr.mjs';
import { generateSecret, otpauthUri, verifyTotp, secondsRemaining, STEP_SECONDS } from './lib/totp.mjs';
import { loadEnrollment, saveEnrollment, clearEnrollment, enrollmentPath } from './lib/authstore.mjs';

const MAX_ATTEMPTS = 3;

export function parseEnrollArgs(argv) {
  const opts = { force: false, color: true, status: false, reset: false };
  for (const arg of argv) {
    if (arg === '--force') opts.force = true;
    else if (arg === '--no-color') opts.color = false;
    else if (arg === '--status') opts.status = true;
    else if (arg === '--reset') opts.reset = true;
    else throw new Error(`Unknown argument: ${arg}. Expected --force, --reset, --status or --no-color.`);
  }
  if (opts.status && opts.reset) throw new Error('--status and --reset do the opposite things; pass one.');
  return opts;
}

function defaultAccount() {
  let user = 'work-hub';
  try { user = os.userInfo().username || user; } catch { /* no passwd entry */ }
  return `${user}@${os.hostname()}`;
}

function supportsColor() {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

async function main() {
  let opts;
  try {
    opts = parseEnrollArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const file = enrollmentPath();

  let existing;
  try {
    existing = loadEnrollment();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (opts.status) {
    if (!existing) {
      console.log(`Not enrolled. No ${file}.`);
      console.log('Run: node src/enroll.mjs');
      process.exit(1);
    }
    console.log(`Enrolled as ${existing.account} (issuer ${existing.issuer})`);
    console.log(`Paired:  ${existing.createdAt ? new Date(existing.createdAt).toLocaleString() : 'unknown'}`);
    console.log(`Secret:  ${file}`);
    return;
  }

  if (opts.reset) {
    const removed = clearEnrollment();
    console.log(removed ? `Removed ${file}. Nobody can sign in until you enroll again.` : `Nothing to remove - ${file} does not exist.`);
    return;
  }

  if (existing && !opts.force) {
    console.log(`Already enrolled as ${existing.account}, paired ${existing.createdAt ? new Date(existing.createdAt).toLocaleString() : 'at an unknown time'}.`);
    console.log('');
    console.log('Re-enrolling mints a NEW secret and the entry already in your authenticator stops working.');
    console.log('If that is what you want: node src/enroll.mjs --force');
    process.exit(1);
  }

  const secret = generateSecret();
  const account = defaultAccount();
  const issuer = 'Work Hub';
  const uri = otpauthUri({ secret, issuer, account });

  console.log('');
  console.log(renderQrToTerminal(uri, { color: opts.color && supportsColor() }));
  console.log('');
  console.log(`Scan the code above with Authy (Add account -> Scan QR code), as ${issuer}: ${account}.`);
  console.log('');
  console.log('If your terminal mangles the code, add the account by hand instead:');
  console.log(`  Secret:    ${secret}`);
  console.log(`  Type:      Time-based, SHA1, 6 digits, ${STEP_SECONDS} second period`);
  console.log(`  Full URI:  ${uri}`);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // A question whose promise never settles once the input ends. Ctrl+D, Ctrl+Z
  // and a piped stdin all reach that state, and without this race the process
  // simply runs out of work and exits 0 - reporting a pairing that never
  // happened to whatever called it.
  let closed = false;
  rl.on('close', () => { closed = true; });
  const ask = async (prompt) => {
    if (closed) return null;
    return Promise.race([
      rl.question(prompt),
      new Promise((resolve) => rl.once('close', () => resolve(null))),
    ]);
  };

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const answer = await ask(`Enter the 6 digit code to confirm the pairing (attempt ${attempt} of ${MAX_ATTEMPTS}): `);
      const typed = answer === null ? '' : answer.trim();
      if (typed === '') {
        console.log(answer === null ? '\nInput ended. Enrollment abandoned; no secret was saved.' : 'Nothing entered. Enrollment abandoned; no secret was saved.');
        process.exitCode = 1;
        return;
      }

      // The code is checked before the clock is: a wrong code and a skewed
      // clock look identical to the user otherwise.
      const result = verifyTotp(secret, typed);
      if (result.ok) {
        const record = saveEnrollment({ secret, issuer, account });
        console.log('');
        console.log(`Paired. Secret written to ${file}.`);
        console.log(`Account: ${record.account}`);
        console.log('');
        console.log('From here the dashboard asks for a 6 digit code instead of a pasted token.');
        console.log('Every session the server had is now invalid; sign in again with your authenticator.');
        return;
      }

      const remaining = secondsRemaining();
      console.log(`  That code did not match. The one on screen has ${remaining}s left; wait for the next one and try again.`);
      if (attempt === MAX_ATTEMPTS) {
        console.log('');
        console.log('Three wrong codes. Nothing was saved, so the old pairing (if any) still works.');
        console.log('If the codes keep failing, check this machine\'s clock: TOTP breaks once it drifts past 30 seconds.');
        process.exitCode = 1;
      }
    }
  } finally {
    rl.close();
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('enroll.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
