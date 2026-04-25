const fs = require('fs');
const path = require('path');

// Write a SSH_ASKPASS helper script that prints the given passphrase to stdout.
//
// Threat model trade-off: the decrypted passphrase lives in plaintext on disk
// for the duration of the ssh handshake. Mode 0700 restricts reads to the
// running uid, and callers MUST unlink the file as soon as ssh exits. There's
// no portable way to feed a passphrase to OpenSSH without an external mechanism
// (ssh-agent or askpass), and ssh-agent has roughly the same exposure profile.
// Don't widen the lifetime by caching this — write fresh per invocation, unlink
// in the caller's `finally`.
//
// Returns { askpassPath, env } — caller merges env into the spawned ssh process'
// environment and unlinks askpassPath after the ssh process exits.
function writeAskpassScript({ tmpDir, id, passphrase }) {
  const askpassPath = path.join(tmpDir, `${id}.askpass`);
  // Single-quote-escape the passphrase. Inside single quotes bash treats
  // every character literally except `'`, which we expand into `'\''`.
  const escaped = String(passphrase).replace(/'/g, "'\\''");
  fs.writeFileSync(
    askpassPath,
    `#!/bin/sh\nprintf '%s\\n' '${escaped}'\n`,
    { mode: 0o700 }
  );
  return {
    askpassPath,
    env: {
      SSH_ASKPASS: askpassPath,
      // Forces ssh to use ASKPASS even when a tty is present (OpenSSH 8.4+).
      SSH_ASKPASS_REQUIRE: 'force',
      // DISPLAY fallback for older OpenSSH that requires it before consulting ASKPASS.
      DISPLAY: ':0',
    },
  };
}

module.exports = { writeAskpassScript };
