const { Database } = require('bun:sqlite');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'backdatup.db');
const db = new Database(dbPath);

// Enable foreign keys
db.exec('PRAGMA foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    job_type TEXT NOT NULL DEFAULT 'full',
    steps TEXT NOT NULL DEFAULT '["backup","persist","cleanup"]',
    env_vars TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    cron_expression TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    schedule_id INTEGER,
    status TEXT NOT NULL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    output TEXT,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );
`);

// Migration: add steps column if it doesn't exist
try {
  db.exec(`ALTER TABLE jobs ADD COLUMN steps TEXT NOT NULL DEFAULT '["backup","persist","cleanup"]'`);
} catch (e) {
  // Column already exists
}

// Jobs queries - using positional parameters for reliability
const jobsQueries = {
  getAll: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC'),
  getById: db.prepare('SELECT * FROM jobs WHERE id = ?'),
  create: db.prepare(`
    INSERT INTO jobs (name, description, job_type, steps, env_vars)
    VALUES (?, ?, ?, ?, ?)
  `),
  update: db.prepare(`
    UPDATE jobs
    SET name = ?, description = ?, job_type = ?, steps = ?, env_vars = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `),
  delete: db.prepare('DELETE FROM jobs WHERE id = ?'),
};

// Wrapper functions for jobs
const jobs = {
  getAll: { all: () => jobsQueries.getAll.all() },
  getById: { get: (id) => jobsQueries.getById.get(id) },
  create: {
    run: ({ name, description, job_type, steps, env_vars }) => {
      return jobsQueries.create.run(name, description, job_type, steps, env_vars);
    }
  },
  update: {
    run: ({ id, name, description, job_type, steps, env_vars }) => {
      return jobsQueries.update.run(name, description, job_type, steps, env_vars, id);
    }
  },
  delete: { run: (id) => jobsQueries.delete.run(id) },
};

// Schedules queries
const schedulesQueries = {
  getByJobId: db.prepare('SELECT * FROM schedules WHERE job_id = ? ORDER BY created_at'),
  getById: db.prepare('SELECT * FROM schedules WHERE id = ?'),
  getAllEnabled: db.prepare(`
    SELECT s.*, j.name as job_name, j.job_type, j.steps, j.env_vars
    FROM schedules s
    JOIN jobs j ON s.job_id = j.id
    WHERE s.enabled = 1
  `),
  create: db.prepare(`
    INSERT INTO schedules (job_id, cron_expression, enabled)
    VALUES (?, ?, ?)
  `),
  update: db.prepare(`
    UPDATE schedules
    SET cron_expression = ?, enabled = ?
    WHERE id = ?
  `),
  delete: db.prepare('DELETE FROM schedules WHERE id = ?'),
};

// Wrapper functions for schedules
const schedules = {
  getByJobId: { all: (jobId) => schedulesQueries.getByJobId.all(jobId) },
  getById: { get: (id) => schedulesQueries.getById.get(id) },
  getAllEnabled: { all: () => schedulesQueries.getAllEnabled.all() },
  create: {
    run: ({ job_id, cron_expression, enabled }) => {
      return schedulesQueries.create.run(job_id, cron_expression, enabled);
    }
  },
  update: {
    run: ({ id, cron_expression, enabled }) => {
      return schedulesQueries.update.run(cron_expression, enabled, id);
    }
  },
  delete: { run: (id) => schedulesQueries.delete.run(id) },
};

// Runs queries
const runsQueries = {
  getByJobId: db.prepare(`
    SELECT * FROM runs WHERE job_id = ?
    ORDER BY started_at DESC LIMIT 50
  `),
  getById: db.prepare('SELECT * FROM runs WHERE id = ?'),
  getActive: db.prepare(`SELECT * FROM runs WHERE status = 'running'`),
  getLastByJobId: db.prepare(`
    SELECT * FROM runs WHERE job_id = ?
    ORDER BY started_at DESC LIMIT 1
  `),
  create: db.prepare(`
    INSERT INTO runs (job_id, schedule_id, status)
    VALUES (?, ?, ?)
  `),
  updateStatus: db.prepare(`
    UPDATE runs
    SET status = ?, finished_at = CURRENT_TIMESTAMP, output = ?
    WHERE id = ?
  `),
  appendOutput: db.prepare(`
    UPDATE runs
    SET output = COALESCE(output, '') || ?
    WHERE id = ?
  `),
};

// Wrapper functions for runs
const runs = {
  getByJobId: { all: (jobId) => runsQueries.getByJobId.all(jobId) },
  getById: { get: (id) => runsQueries.getById.get(id) },
  getActive: { all: () => runsQueries.getActive.all() },
  getLastByJobId: { get: (jobId) => runsQueries.getLastByJobId.get(jobId) },
  create: {
    run: ({ job_id, schedule_id, status }) => {
      return runsQueries.create.run(job_id, schedule_id, status);
    }
  },
  updateStatus: {
    run: ({ id, status, output }) => {
      return runsQueries.updateStatus.run(status, output, id);
    }
  },
  appendOutput: {
    run: ({ id, output }) => {
      return runsQueries.appendOutput.run(output, id);
    }
  },
};

module.exports = {
  db,
  jobs,
  schedules,
  runs,
};
