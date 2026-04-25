const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const { db, sshEndpoints } = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { writeAskpassScript } = require('../ssh-askpass');

const router = express.Router();

const TEST_DIR = path.join(os.tmpdir(), 'backdatup-keys');

function ensureTestDir() {
  fs.mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

function validateBody(body, { keyRequired }) {
  const errors = [];
  if (!body.name || typeof body.name !== 'string') errors.push('name is required');
  if (!body.host || typeof body.host !== 'string') errors.push('host is required');
  if (!body.username || typeof body.username !== 'string') errors.push('username is required');
  const port = parseInt(body.port, 10);
  if (!port || port < 1 || port > 65535) errors.push('port must be between 1 and 65535');
  if (keyRequired && (!body.private_key || typeof body.private_key !== 'string' || body.private_key.trim().length === 0)) {
    errors.push('private_key is required');
  }
  if (body.private_key !== undefined && typeof body.private_key !== 'string') {
    errors.push('private_key must be a string');
  }
  if (body.passphrase !== undefined && body.passphrase !== null && typeof body.passphrase !== 'string') {
    errors.push('passphrase must be a string');
  }
  return { errors, port };
}

// Normalize a pasted PEM block: strip CRLF (Windows clipboards), trim leading
// whitespace before the first BEGIN line, ensure exactly one trailing newline.
// ssh refuses to load keys with CRLF endings ('invalid format') so this is
// defensive against the most common copy/paste corruption path.
function normalizePrivateKey(key) {
  return String(key).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\s+/, '').replace(/\s*$/, '\n');
}

// GET /api/ssh-endpoints — list (no key material)
router.get('/', (req, res) => {
  try {
    res.json(sshEndpoints.getAll.all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ssh-endpoints/:id — detail (no key material)
router.get('/:id', (req, res) => {
  try {
    const ep = sshEndpoints.getByIdSafe.get(req.params.id);
    if (!ep) return res.status(404).json({ error: 'SSH endpoint not found' });
    res.json(ep);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ssh-endpoints — create
router.post('/', (req, res) => {
  try {
    const { errors, port } = validateBody(req.body, { keyRequired: true });
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const keyEnc = encrypt(normalizePrivateKey(req.body.private_key));
    const passEnc = (typeof req.body.passphrase === 'string' && req.body.passphrase.length > 0)
      ? encrypt(req.body.passphrase)
      : null;

    const result = sshEndpoints.create.run({
      name: req.body.name,
      description: req.body.description || null,
      host: req.body.host,
      port,
      username: req.body.username,
      ciphertext: keyEnc.ciphertext,
      iv: keyEnc.iv,
      tag: keyEnc.tag,
      passphrase: passEnc,
      known_hosts: null,
    });
    const created = sshEndpoints.getByIdSafe.get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ error: 'SSH endpoint name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/ssh-endpoints/:id — update (private_key optional)
router.put('/:id', (req, res) => {
  try {
    const existing = sshEndpoints.getByIdSafe.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'SSH endpoint not found' });

    const { errors, port } = validateBody(req.body, { keyRequired: false });
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    // Encrypt outside the transaction (sync but heavier than a DB op)
    const replaceKey = typeof req.body.private_key === 'string' && req.body.private_key.trim().length > 0;
    const keyEnc = replaceKey ? encrypt(normalizePrivateKey(req.body.private_key)) : null;

    // Passphrase handling:
    //   clear_passphrase=true  -> wipe the passphrase columns
    //   passphrase non-empty   -> encrypt and replace
    //   omitted/empty          -> keep existing
    const clearPass = !!req.body.clear_passphrase;
    const replacePass = !clearPass && typeof req.body.passphrase === 'string' && req.body.passphrase.length > 0;
    const passEnc = replacePass ? encrypt(req.body.passphrase) : null;

    // All-or-nothing
    db.transaction(() => {
      sshEndpoints.updateMeta.run({
        id: req.params.id,
        name: req.body.name,
        description: req.body.description ?? null,
        host: req.body.host,
        port,
        username: req.body.username,
      });

      if (keyEnc) {
        sshEndpoints.updateKey.run({
          id: req.params.id,
          ciphertext: keyEnc.ciphertext,
          iv: keyEnc.iv,
          tag: keyEnc.tag,
        });
        // Invalidate the cached known_hosts: a new key likely targets a new host fingerprint
        sshEndpoints.updateTestStatus.run({
          id: req.params.id,
          status: 'untested',
          error: null,
          known_hosts: '',
        });
      }

      if (clearPass) {
        sshEndpoints.clearPassphrase.run(req.params.id);
      } else if (passEnc) {
        sshEndpoints.updatePassphrase.run({
          id: req.params.id,
          ciphertext: passEnc.ciphertext,
          iv: passEnc.iv,
          tag: passEnc.tag,
        });
      }
    })();

    res.json(sshEndpoints.getByIdSafe.get(req.params.id));
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ error: 'SSH endpoint name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ssh-endpoints/:id
router.delete('/:id', (req, res) => {
  try {
    const existing = sshEndpoints.getByIdSafe.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'SSH endpoint not found' });
    sshEndpoints.delete.run(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ssh-endpoints/:id/public-key — derive the OpenSSH public key from the stored private key
router.get('/:id/public-key', (req, res) => {
  let keyPath = null;
  try {
    const ep = sshEndpoints.getById.get(req.params.id);
    if (!ep) return res.status(404).json({ error: 'SSH endpoint not found' });

    ensureTestDir();
    const id = uuidv4();
    keyPath = path.join(TEST_DIR, `${id}.pem`);

    const privateKey = decrypt({
      ciphertext: ep.private_key_ciphertext,
      iv: ep.private_key_iv,
      tag: ep.private_key_tag,
    });
    fs.writeFileSync(keyPath, privateKey.endsWith('\n') ? privateKey : privateKey + '\n', { mode: 0o600 });

    // Trade-off: when the key is passphrased, the passphrase is passed via -P
    // and is briefly visible in the running ssh-keygen process's argv (/proc/<pid>/cmdline).
    // Exposure window is ~tens of ms and limited to the same uid. Acceptable for
    // an admin-only tool; not for multi-tenant.
    const args = ['-y', '-f', keyPath];
    if (ep.passphrase_ciphertext) {
      const pass = decrypt({
        ciphertext: ep.passphrase_ciphertext,
        iv: ep.passphrase_iv,
        tag: ep.passphrase_tag,
      });
      args.push('-P', pass);
    }

    const result = spawnSync('ssh-keygen', args, { encoding: 'utf8' });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
      return res.status(500).json({ error: `ssh-keygen failed: ${detail}` });
    }

    const publicKey = result.stdout.trim();
    res.json({
      public_key: publicKey,
      // Suggested authorized_keys line including a comment naming the endpoint
      authorized_keys_line: `${publicKey} backdatup:${ep.name}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (keyPath) safeUnlink(keyPath);
  }
});

// POST /api/ssh-endpoints/:id/test — connect, capture host fingerprint, persist status
router.post('/:id/test', async (req, res) => {
  let keyPath = null;
  let knownHostsPath = null;
  let askpassPath = null;
  try {
    const ep = sshEndpoints.getById.get(req.params.id);
    if (!ep) return res.status(404).json({ error: 'SSH endpoint not found' });

    ensureTestDir();
    const id = uuidv4();
    keyPath = path.join(TEST_DIR, `${id}.pem`);
    knownHostsPath = path.join(TEST_DIR, `${id}.known_hosts`);

    const privateKey = decrypt({
      ciphertext: ep.private_key_ciphertext,
      iv: ep.private_key_iv,
      tag: ep.private_key_tag,
    });
    fs.writeFileSync(keyPath, privateKey.endsWith('\n') ? privateKey : privateKey + '\n', { mode: 0o600 });
    fs.writeFileSync(knownHostsPath, '', { mode: 0o600 });

    // If the key has a passphrase, write a SSH_ASKPASS helper that prints it.
    // ssh invokes this helper non-interactively when SSH_ASKPASS_REQUIRE=force.
    const sshEnv = { ...process.env };
    const hasPassphrase = !!ep.passphrase_ciphertext;
    if (hasPassphrase) {
      const passphrase = decrypt({
        ciphertext: ep.passphrase_ciphertext,
        iv: ep.passphrase_iv,
        tag: ep.passphrase_tag,
      });
      const ask = writeAskpassScript({ tmpDir: TEST_DIR, id, passphrase });
      askpassPath = ask.askpassPath;
      Object.assign(sshEnv, ask.env);
    }

    const args = [
      '-T',
      '-i', keyPath,
      '-o', `UserKnownHostsFile=${knownHostsPath}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      // BatchMode=yes disables ASKPASS too — only set it when there's no passphrase
      '-o', `BatchMode=${hasPassphrase ? 'no' : 'yes'}`,
      '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'ConnectTimeout=5',
      '-p', String(ep.port),
      `${ep.username}@${ep.host}`,
      'exit',
    ];

    const result = await new Promise((resolve) => {
      const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env: sshEnv });
      let stderrBuf = '';
      let stdoutBuf = '';
      child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
      child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
      child.on('error', (e) => resolve({ code: -1, stderr: e.message, stdout: '' }));
      child.on('close', (code) => resolve({ code, stderr: stderrBuf, stdout: stdoutBuf }));
    });

    if (result.code === 0) {
      const capturedKnownHosts = fs.readFileSync(knownHostsPath, 'utf8');
      sshEndpoints.updateTestStatus.run({
        id: req.params.id,
        status: 'ok',
        error: null,
        known_hosts: capturedKnownHosts,
      });
      res.json({
        status: 'ok',
        known_hosts: capturedKnownHosts,
        known_hosts_captured: capturedKnownHosts.length > 0,
      });
    } else {
      const errorOutput = (result.stderr || result.stdout || `exit code ${result.code}`).trim();
      sshEndpoints.updateTestStatus.run({
        id: req.params.id,
        status: 'fail',
        error: errorOutput.slice(0, 2000),
        known_hosts: null,
      });
      res.status(200).json({ status: 'fail', error: errorOutput });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (keyPath) safeUnlink(keyPath);
    if (knownHostsPath) safeUnlink(knownHostsPath);
    if (askpassPath) safeUnlink(askpassPath);
  }
});

module.exports = router;
