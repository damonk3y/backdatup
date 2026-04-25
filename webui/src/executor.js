const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { runs, sshEndpoints } = require('./db');
const { openTunnel } = require('./tunnel');

// Same condensed fingerprint summarisation as the UI uses, so banners and
// the "Test Connection" alert show consistent strings for operator verification.
function summarizeKnownHosts(knownHosts) {
  if (!knownHosts) return '';
  const line = knownHosts.split('\n').find(l => l.trim() && !l.startsWith('#'));
  if (!line) return '';
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) return line.trim().slice(0, 80);
  const [, type, key] = parts;
  return `${type} ${key.slice(0, 24)}…${key.slice(-8)}`;
}

// Available steps and their make targets based on job type
const STEP_TARGETS = {
  full: {
    backup: 'backup',
    persist: 'persist',
    cleanup: 'cleanup',
  },
  psql: {
    backup: 'backup-psql',
    persist: 'persist',
    cleanup: 'cleanup',
  },
  minio: {
    backup: 'backup-minio',
    persist: 'persist',
    cleanup: 'cleanup',
  },
};

// Track active runs for cancellation. Value: { child, tunnel }
const activeProcesses = new Map();

// Single-quote a value for safe inclusion in a bash-sourced env file.
// Wraps in single quotes; embedded single quotes are escaped as '\''.
function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

async function executeJob(job, scheduleId = null) {
  const runInfo = runs.create.run({
    job_id: job.id,
    schedule_id: scheduleId,
    status: 'running',
  });
  const runId = runInfo.lastInsertRowid;

  console.log(`[Executor] Starting job "${job.name}" (ID: ${job.id}), Run ID: ${runId}`);

  const envVars = JSON.parse(job.env_vars);
  const steps = JSON.parse(job.steps || '["backup","persist","cleanup"]');
  const tempEnvFile = path.join(__dirname, '..', 'data', `.env.${uuidv4()}`);
  const appDir = path.resolve(__dirname, '..', '..');

  console.log(`[Executor] Working directory: ${appDir}`);
  console.log(`[Executor] Steps to run: ${steps.join(' -> ')}`);

  const stepTargets = STEP_TARGETS[job.job_type] || STEP_TARGETS.full;

  let totalOutput = `Job: ${job.name}\nType: ${job.job_type}\nSteps: ${steps.join(' -> ')}\nWorking Dir: ${appDir}\nStarted: ${new Date().toISOString()}\n`;
  runs.appendOutput.run({ id: runId, output: totalOutput });

  const usesTunnel = job.ssh_endpoint_id && (job.job_type === 'psql' || job.job_type === 'full');
  let tunnel = null;

  if (job.ssh_endpoint_id && !usesTunnel) {
    const skipMsg = `[tunnel] ssh_endpoint_id is set but job_type "${job.job_type}" does not support tunneling — proceeding without a tunnel.\n`;
    totalOutput += skipMsg;
    runs.appendOutput.run({ id: runId, output: skipMsg });
  }

  try {
    // === Tunnel setup (psql / full jobs with an ssh endpoint) ===
    if (usesTunnel) {
      if (!envVars.POSTGRES_HOST || !envVars.POSTGRES_PORT) {
        throw new Error('Tunneled psql job missing POSTGRES_HOST or POSTGRES_PORT in env_vars');
      }

      const endpoint = sshEndpoints.getById.get(job.ssh_endpoint_id);
      if (!endpoint) {
        throw new Error(`SSH endpoint ${job.ssh_endpoint_id} not found`);
      }

      const originalHost = envVars.POSTGRES_HOST;
      const originalPort = envVars.POSTGRES_PORT;

      const openingMsg = `[tunnel] Opening via "${endpoint.name}" (${endpoint.username}@${endpoint.host}:${endpoint.port}) -> ${originalHost}:${originalPort}\n`;
      totalOutput += openingMsg;
      runs.appendOutput.run({ id: runId, output: openingMsg });

      tunnel = await openTunnel({
        endpoint,
        remoteHost: originalHost,
        remotePort: parseInt(originalPort, 10),
      });

      envVars.POSTGRES_HOST = '127.0.0.1';
      envVars.POSTGRES_PORT = String(tunnel.localPort);

      const fp = summarizeKnownHosts(endpoint.known_hosts);
      const fpSuffix = fp ? ` (host key: ${fp})` : '';
      const activeMsg = `[tunnel] Active: 127.0.0.1:${tunnel.localPort} -> ${originalHost}:${originalPort}${fpSuffix}\n`;
      totalOutput += activeMsg;
      runs.appendOutput.run({ id: runId, output: activeMsg });
    }

    // Write env file with rewritten values, single-quote-escaped, restrictive perms
    const envContent = Object.entries(envVars)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join('\n');
    fs.writeFileSync(tempEnvFile, envContent, { mode: 0o600 });

    console.log(`[Executor] Env file written: ${tempEnvFile}`);

    const spawnOptions = {
      cwd: appDir,
      env: {
        ...process.env,
        ...envVars,
        BACKDATUP_ENV_FILE: tempEnvFile,
        BACKUP_TYPE: job.job_type,
      },
      shell: true,
    };

    // Execute each configured step in sequence
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const makeTarget = stepTargets[step];

      if (!makeTarget) {
        const warnMsg = `\n[Warning] Unknown step: ${step}, skipping\n`;
        totalOutput += warnMsg;
        runs.appendOutput.run({ id: runId, output: warnMsg });
        continue;
      }

      const stepHeader = `\n${'='.repeat(50)}\n[Step ${i + 1}/${steps.length}] Running: make ${makeTarget}\n${'='.repeat(50)}\n`;
      totalOutput += stepHeader;
      runs.appendOutput.run({ id: runId, output: stepHeader });

      console.log(`[Executor] Running: make ${makeTarget} in ${appDir}`);

      const child = spawn('make', [makeTarget], spawnOptions);
      activeProcesses.set(runId, { child, tunnel });

      console.log(`[Executor] Spawned process PID: ${child.pid}`);

      const result = await new Promise((resolve) => {
        let stepOutput = '';

        child.stdout.on('data', (data) => {
          const text = data.toString();
          stepOutput += text;
          totalOutput += text;
          runs.appendOutput.run({ id: runId, output: text });
        });

        child.stderr.on('data', (data) => {
          const text = data.toString();
          stepOutput += text;
          totalOutput += text;
          runs.appendOutput.run({ id: runId, output: text });
        });

        child.on('close', (code) => {
          console.log(`[Executor] Process closed with code: ${code}`);
          resolve({ code, output: stepOutput });
        });

        child.on('error', (err) => {
          console.error(`[Executor] Process error:`, err);
          const errorText = `\nProcess error: ${err.message}\n`;
          stepOutput += errorText;
          totalOutput += errorText;
          runs.appendOutput.run({ id: runId, output: errorText });
          resolve({ code: 1, output: stepOutput, error: err });
        });
      });

      activeProcesses.delete(runId);

      if (result.code !== 0) {
        const errorMsg = `\n[Step ${i + 1}/${steps.length}] FAILED: make ${makeTarget} (exit code: ${result.code})\n`;
        totalOutput += errorMsg;
        runs.updateStatus.run({ id: runId, status: 'failed', output: totalOutput });
        return { runId, status: 'failed', output: totalOutput, failedStep: step };
      }

      const successMsg = `\n[Step ${i + 1}/${steps.length}] COMPLETED: make ${makeTarget}\n`;
      totalOutput += successMsg;
      runs.appendOutput.run({ id: runId, output: successMsg });
    }

    const completeMsg = `\n${'='.repeat(50)}\nAll steps completed successfully\nFinished: ${new Date().toISOString()}\n${'='.repeat(50)}\n`;
    totalOutput += completeMsg;
    runs.updateStatus.run({ id: runId, status: 'success', output: totalOutput });
    console.log(`[Executor] Job "${job.name}" completed successfully`);
    return { runId, status: 'success', output: totalOutput };

  } catch (err) {
    console.error(`[Executor] Job "${job.name}" failed with error:`, err);
    const errorOutput = totalOutput + `\n\nFATAL ERROR: ${err.message}\nStack: ${err.stack}\n`;
    runs.updateStatus.run({ id: runId, status: 'failed', output: errorOutput });
    return { runId, status: 'failed', output: errorOutput };
  } finally {
    activeProcesses.delete(runId);
    if (tunnel) {
      try { tunnel.close(); } catch (_) { /* ignore */ }
    }
    cleanupEnvFile(tempEnvFile);
  }
}

function cleanupEnvFile(tempEnvFile) {
  try {
    fs.unlinkSync(tempEnvFile);
  } catch (e) {
    // Ignore cleanup errors (file may not exist if we failed before writing)
  }
}

function cancelRun(runId) {
  const tracked = activeProcesses.get(runId);
  if (tracked) {
    try { tracked.child.kill('SIGTERM'); } catch (_) {}
    if (tracked.tunnel) {
      try { tracked.tunnel.close(); } catch (_) {}
    }
    activeProcesses.delete(runId);
    // Append a cancel marker; do NOT read-then-write the output column —
    // late stdout chunks from the dying child can land between the read and
    // the write and would be lost. updateStatusOnly leaves output untouched
    // so concurrent appendOutput calls are safe.
    const marker = `\n${'='.repeat(50)}\n[CANCELLED] Run cancelled by user at ${new Date().toISOString()}\n${'='.repeat(50)}\n`;
    runs.appendOutput.run({ id: runId, output: marker });
    runs.updateStatusOnly.run({ id: runId, status: 'failed' });
    return true;
  }
  return false;
}

function isRunActive(runId) {
  return activeProcesses.has(runId);
}

module.exports = {
  executeJob,
  cancelRun,
  isRunActive,
};
