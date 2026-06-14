const fss = require('fs');
const fs = fss.promises;
const path = require('path');
const { spawn } = require('child_process');
const { jobs } = require('./db');

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Fast directory size using du (single process, native speed).
// Falls back to 0 on any error. Only used for top-level backup *dirs* during listing.
async function getDirSize(dir) {
  return new Promise((resolve) => {
    const child = spawn('du', ['-sk', dir]);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', () => {
      const kb = parseInt((out || '').trim().split(/\s+/)[0], 10) || 0;
      resolve(kb * 1024);
    });
    child.on('error', () => resolve(0));
  });
}

function isSafeUnder(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function resolveJobBackupBase(jobId) {
  const job = jobs.getById.get(jobId);
  if (!job) {
    const e = new Error('Job not found');
    e.status = 404;
    throw e;
  }
  const envVars = JSON.parse(job.env_vars || '{}');
  const raidPath = envVars.RAID_PATH;
  const environment = envVars.ENVIRONMENT;
  if (!raidPath || !environment) {
    const e = new Error('Job configuration is missing RAID_PATH or ENVIRONMENT');
    e.status = 400;
    throw e;
  }
  // NOTE: RAID_PATH comes from the (editable) job env_vars. We intentionally
  // trust it the same way the backup/restore/persist scripts already do.
  // This means list/download have the same filesystem reach as job execution.
  // Only names matching our backup patterns under backthatup/<env>/(psql|minio)
  // are exposed. See security considerations in code review.
  const baseDir = path.resolve(raidPath, 'backthatup', environment);
  return { job, envVars, baseDir };
}

async function listBackups(jobId) {
  const { job, envVars, baseDir } = await resolveJobBackupBase(jobId);
  const psqlDir = path.join(baseDir, 'psql');
  const minioDir = path.join(baseDir, 'minio');

  const psql = [];
  const minio = [];

  // Derive job-specific prefix for filtering.
  // PSQL backups are named {POSTGRES_DB}_YYYYMMDD_HHMMSS
  // This ensures the list shown for a job only contains backups produced by *that* job's database.
  const psqlPrefix = (envVars.POSTGRES_DB || '').trim();
  // For MinIO we currently do not force a bucket filter (buckets are often cross-service assets),
  // but if a job declares MINIO_BUCKET we can scope later. For now, return all minio under the env.

  // PostgreSQL directory backups (e.g. mydb_20260110_151532)
  try {
    if (await pathExists(psqlDir)) {
      const entries = await fs.readdir(psqlDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && /_\d{8}_\d{6}$/.test(entry.name)) {
          // Job-scoped filter: only include backups whose name starts with this job's DB
          if (psqlPrefix && !entry.name.startsWith(psqlPrefix + '_')) continue;

          const fullPath = path.join(psqlDir, entry.name);
          if (!isSafeUnder(fullPath, psqlDir)) continue;
          const mtime = (await fs.stat(fullPath)).mtime.toISOString();
          const size = await getDirSize(fullPath);
          psql.push({ name: entry.name, type: 'psql', mtime, size, isDir: true });
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[backups] list psql error:', err.message);
  }

  // MinIO .tar.gz archives
  try {
    if (await pathExists(minioDir)) {
      const entries = await fs.readdir(minioDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.tar.gz')) {
          const fullPath = path.join(minioDir, entry.name);
          if (!isSafeUnder(fullPath, minioDir)) continue;
          const st = await fs.stat(fullPath);
          minio.push({
            name: entry.name,
            type: 'minio',
            mtime: st.mtime.toISOString(),
            size: st.size,
            isDir: false,
          });
        }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[backups] list minio error:', err.message);
  }

  // Newest first
  psql.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  minio.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

  return {
    job_id: job.id,
    job_name: job.name,
    job_type: job.job_type,
    base: baseDir,
    environment: envVars.ENVIRONMENT,
    psql_prefix: psqlPrefix || null,
    psql,
    minio,
  };
}

async function streamBackupDownload(jobId, backupName, res, req) {
  const { baseDir, envVars } = await resolveJobBackupBase(jobId);
  const name = backupName;

  if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name) || name.includes('..')) {
    const e = new Error('Invalid backup name');
    e.status = 400;
    throw e;
  }

  // Defense-in-depth: if the job has a POSTGRES_DB, only allow downloads whose name matches that prefix
  // for psql-style directory names. Mirrors the list filter.
  const psqlPrefix = (envVars.POSTGRES_DB || '').trim();
  const looksLikePsqlBackup = /_\d{8}_\d{6}$/.test(name) && !name.endsWith('.tar.gz');
  if (psqlPrefix && looksLikePsqlBackup && !name.startsWith(psqlPrefix + '_')) {
    const e = new Error('Backup not available for this job');
    e.status = 404;
    throw e;
  }

  const psqlPath = path.resolve(baseDir, 'psql', name);
  const minioPath = path.resolve(baseDir, 'minio', name);

  let target = null;
  let isDir = false;
  let downloadName = null;

  if (await pathExists(psqlPath)) {
    try {
      const st = await fs.stat(psqlPath);
      if (st.isDirectory() && isSafeUnder(psqlPath, path.join(baseDir, 'psql'))) {
        target = psqlPath;
        isDir = true;
        downloadName = `${name}.tar.gz`;
      }
    } catch (_) {}
  }

  if (!target && await pathExists(minioPath)) {
    try {
      const st = await fs.stat(minioPath);
      if (st.isFile() && isSafeUnder(minioPath, path.join(baseDir, 'minio'))) {
        target = minioPath;
        isDir = false;
        downloadName = name;
      }
    } catch (_) {}
  }

  if (!target) {
    const e = new Error('Backup not found');
    e.status = 404;
    throw e;
  }

  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);

  if (isDir) {
    res.setHeader('Content-Type', 'application/gzip');
    const parent = path.dirname(target);
    const dirName = path.basename(target);
    const q = (v) => `'${String(v ?? '').replace(/'/g, "'\\''")}'`;
    const cmd = `tar -C ${q(parent)} -cf - ${q(dirName)} | gzip -c`;
    const proc = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });

    const onClose = () => {
      try { proc.kill('SIGTERM'); } catch (_) {}
    };
    req.on('close', onClose);

    proc.stdout.pipe(res);

    proc.stderr.on('data', (d) => {
      console.error(`[backups] tar stderr (${name}):`, d.toString().trim());
    });

    proc.on('error', (err) => {
      console.error('[backups] tar process error:', err);
      if (!res.headersSent) res.status(500);
      if (!res.writableEnded) res.end('Archive creation failed');
    });

    proc.on('close', (code) => {
      req.off('close', onClose);
      if (code !== 0 && !res.writableEnded) {
        try { res.end(); } catch (_) {}
      }
    });
  } else {
    res.setHeader('Content-Type', 'application/gzip');
    const stream = fss.createReadStream(target);
    stream.on('error', (err) => {
      console.error('[backups] read stream error:', err.message);
      if (!res.writableEnded) {
        try { res.end(); } catch (_) {}
      }
    });
    stream.pipe(res);
  }
}

module.exports = {
  listBackups,
  streamBackupDownload,
};
