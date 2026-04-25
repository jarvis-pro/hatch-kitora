/**
 * Node.js `-r` preload — runs before any other module in the process.
 *
 * Wraps `process.stderr.write` to silently drop the `CredentialsSignin`
 * header + stack trace that next-auth v5 beta + Next.js's internal
 * `Log.error` emit on every wrong-password attempt. Real auth errors
 * (DB outage, OAuth misconfig) still bubble up unaffected.
 *
 * Wired up via `NODE_OPTIONS="-r ./scripts/silence-auth-noise.cjs"` in
 * `playwright.config.ts` (and optionally in production deploy env).
 *
 * Implementation note — the noise comes through as TWO separate
 * `console.error` calls (header, then stack), each landing as its own
 * `stderr.write` chunk. The header carries the `CredentialsSignin` /
 * `[auth][error]` keyword and trips the suppression flag; the stack
 * chunk arrives next and is dropped because every line starts with
 * `\s+at `. Patching `console.error` directly used to short-circuit
 * before the flag could flip — that's the bug we don't want again.
 */

const looksLikeAuthNoise = (msg) =>
  msg.includes('CredentialsSignin') || msg.includes('[auth][error]');

let suppressing = false;

const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function patchedWrite(chunk, ...rest) {
  const str =
    typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';

  if (str && looksLikeAuthNoise(str)) {
    suppressing = true;
    return true;
  }

  if (suppressing) {
    // Stack continuation lines start with whitespace + `at `. Trailing
    // blank lines also belong to the stack. Anything else is unrelated
    // output, so flip suppression off and write through.
    if (/^\s+at\s/.test(str) || str === '\n' || str === '') return true;
    suppressing = false;
  }

  return origStderrWrite(chunk, ...rest);
};
