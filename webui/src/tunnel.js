const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { decrypt } = require('./crypto');
const { writeAskpassScript } = require('./ssh-askpass');

const TUNNEL_DIR = path.join(os.tmpdir(), 'backdatup-keys');
const BUFFER_CAP = 8 * 1024;

function ensureTunnelDir() {
  fs.mkdirSync(TUNNEL_DIR, { recursive: true, mode: 0o700 });
}

// On module load (= server boot): wipe any leftover key/known_hosts files
// from a previous crashed process, since the cleanup in close() can't run on hard kill.
function wipeStaleTunnelFiles() {
  try {
    if (!fs.existsSync(TUNNEL_DIR)) return;
    for (const name of fs.readdirSync(TUNNEL_DIR)) {
      try { fs.unlinkSync(path.join(TUNNEL_DIR, name)); } catch (_) {}
    }
  } catch (_) { /* ignore */ }
}
wipeStaleTunnelFiles();

// Bounded append: keep only the last BUFFER_CAP bytes of accumulated text
function appendCapped(prev, chunk) {
  const next = prev + chunk;
  return next.length > BUFFER_CAP ? next.slice(-BUFFER_CAP) : next;
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
  } catch (_) { /* ignore */ }
}

async function openTunnel({ endpoint, remoteHost, remotePort, timeoutMs = 8000 }) {
  if (!endpoint) throw new Error('openTunnel: endpoint required');
  if (!remoteHost) throw new Error('openTunnel: remoteHost required');
  if (!remotePort) throw new Error('openTunnel: remotePort required');
  if (!endpoint.known_hosts) {
    throw new Error(
      `SSH endpoint "${endpoint.name}" has no verified host fingerprint. ` +
      `Click "Test connection" on the endpoint first.`
    );
  }

  ensureTunnelDir();

  const id = uuidv4();
  const keyPath = path.join(TUNNEL_DIR, `${id}.pem`);
  const knownHostsPath = path.join(TUNNEL_DIR, `${id}.known_hosts`);
  let askpassPath = null;

  // Decrypt private key and write with strict perms
  const privateKey = decrypt({
    ciphertext: endpoint.private_key_ciphertext,
    iv: endpoint.private_key_iv,
    tag: endpoint.private_key_tag,
  });
  fs.writeFileSync(keyPath, privateKey.endsWith('\n') ? privateKey : privateKey + '\n', { mode: 0o600 });
  fs.writeFileSync(knownHostsPath, endpoint.known_hosts, { mode: 0o600 });

  // Optional passphrase: feed via SSH_ASKPASS helper script
  const sshEnv = { ...process.env };
  const hasPassphrase = !!endpoint.passphrase_ciphertext;
  if (hasPassphrase) {
    const passphrase = decrypt({
      ciphertext: endpoint.passphrase_ciphertext,
      iv: endpoint.passphrase_iv,
      tag: endpoint.passphrase_tag,
    });
    const ask = writeAskpassScript({ tmpDir: TUNNEL_DIR, id, passphrase });
    askpassPath = ask.askpassPath;
    Object.assign(sshEnv, ask.env);
  }

  const localPort = await pickFreePort();

  const args = [
    '-N', '-T',
    '-i', keyPath,
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    // BatchMode=yes disables ASKPASS — only set when there's no passphrase
    '-o', `BatchMode=${hasPassphrase ? 'no' : 'yes'}`,
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', `ConnectTimeout=${Math.max(3, Math.floor(timeoutMs / 1000))}`,
    '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
    '-p', String(endpoint.port),
    `${endpoint.username}@${endpoint.host}`,
  ];

  const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env: sshEnv });
  let stderrBuf = '';
  let stdoutBuf = '';
  child.stderr.on('data', (d) => { stderrBuf = appendCapped(stderrBuf, d.toString()); });
  child.stdout.on('data', (d) => { stdoutBuf = appendCapped(stdoutBuf, d.toString()); });

  let exited = false;
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (!exited) {
      try { child.kill('SIGTERM'); } catch (_) {}
      // Hard fallback if it lingers
      setTimeout(() => {
        if (!exited) {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
      }, 1500).unref?.();
    }
    safeUnlink(keyPath);
    safeUnlink(knownHostsPath);
    if (askpassPath) safeUnlink(askpassPath);
  };

  // Poll the local port until it accepts, or the ssh proc dies, or we time out
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (exited) {
      close();
      const detail = (stderrBuf || stdoutBuf || '').trim() || `exit ${exitInfo?.code} signal ${exitInfo?.signal}`;
      throw new Error(`SSH tunnel failed: ${detail}`);
    }
    if (await probePort(localPort)) {
      return { localPort, close };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  close();
  const detail = (stderrBuf || stdoutBuf || '').trim() || 'no output';
  throw new Error(`SSH tunnel timed out after ${timeoutMs}ms: ${detail}`);
}

module.exports = { openTunnel };
