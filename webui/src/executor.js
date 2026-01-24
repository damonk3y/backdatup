const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { runs } = require('./db');

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

// Track active processes for potential cancellation
const activeProcesses = new Map();

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

  // Get make targets for this job type
  const stepTargets = STEP_TARGETS[job.job_type] || STEP_TARGETS.full;

  // Initial output with job info
  let totalOutput = `Job: ${job.name}\nType: ${job.job_type}\nSteps: ${steps.join(' -> ')}\nWorking Dir: ${appDir}\nStarted: ${new Date().toISOString()}\n`;

  // Save initial output
  runs.appendOutput.run({ id: runId, output: totalOutput });

  try {
    // Write env vars to temp file
    const envContent = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    fs.writeFileSync(tempEnvFile, envContent);

    console.log(`[Executor] Env file written: ${tempEnvFile}`);

    const spawnOptions = {
      cwd: appDir,
      env: {
        ...process.env,
        ...envVars,
        // Tell scripts to use this env file instead of .env
        BACKDATUP_ENV_FILE: tempEnvFile,
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

      // Log step start
      const stepHeader = `\n${'='.repeat(50)}\n[Step ${i + 1}/${steps.length}] Running: make ${makeTarget}\n${'='.repeat(50)}\n`;
      totalOutput += stepHeader;
      runs.appendOutput.run({ id: runId, output: stepHeader });

      console.log(`[Executor] Running: make ${makeTarget} in ${appDir}`);

      // Run the step
      const child = spawn('make', [makeTarget], spawnOptions);
      activeProcesses.set(runId, child);

      // Log spawn info
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

      // If step failed, stop the workflow
      if (result.code !== 0) {
        const errorMsg = `\n[Step ${i + 1}/${steps.length}] FAILED: make ${makeTarget} (exit code: ${result.code})\n`;
        totalOutput += errorMsg;
        runs.updateStatus.run({ id: runId, status: 'failed', output: totalOutput });

        cleanup(tempEnvFile);
        return { runId, status: 'failed', output: totalOutput, failedStep: step };
      }

      // Log step success
      const successMsg = `\n[Step ${i + 1}/${steps.length}] COMPLETED: make ${makeTarget}\n`;
      totalOutput += successMsg;
      runs.appendOutput.run({ id: runId, output: successMsg });
    }

    // All steps completed
    const completeMsg = `\n${'='.repeat(50)}\nAll steps completed successfully\nFinished: ${new Date().toISOString()}\n${'='.repeat(50)}\n`;
    totalOutput += completeMsg;
    runs.updateStatus.run({ id: runId, status: 'success', output: totalOutput });

    console.log(`[Executor] Job "${job.name}" completed successfully`);

    cleanup(tempEnvFile);
    return { runId, status: 'success', output: totalOutput };

  } catch (err) {
    console.error(`[Executor] Job "${job.name}" failed with error:`, err);
    const errorOutput = totalOutput + `\n\nFATAL ERROR: ${err.message}\nStack: ${err.stack}\n`;
    runs.updateStatus.run({ id: runId, status: 'failed', output: errorOutput });

    cleanup(tempEnvFile);
    return { runId, status: 'failed', output: errorOutput };
  }
}

function cleanup(tempEnvFile) {
  try {
    fs.unlinkSync(tempEnvFile);
  } catch (e) {
    // Ignore cleanup errors
  }
}

function cancelRun(runId) {
  const child = activeProcesses.get(runId);
  if (child) {
    child.kill('SIGTERM');
    activeProcesses.delete(runId);
    runs.updateStatus.run({ id: runId, status: 'failed', output: 'Cancelled by user' });
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
