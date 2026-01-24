const express = require('express');
const { jobs, schedules, runs } = require('../db');
const scheduler = require('../scheduler');

const router = express.Router();

const DEFAULT_STEPS = ['backup', 'persist', 'cleanup'];

// Helper to parse job JSON fields
function parseJob(job) {
  return {
    ...job,
    env_vars: JSON.parse(job.env_vars),
    steps: JSON.parse(job.steps || JSON.stringify(DEFAULT_STEPS)),
  };
}

// GET /api/jobs - List all jobs
router.get('/', (req, res) => {
  try {
    const allJobs = jobs.getAll.all();

    // Enrich with last run info and next scheduled run
    const enrichedJobs = allJobs.map((job) => {
      const lastRun = runs.getLastByJobId.get(job.id);
      const jobSchedules = schedules.getByJobId.all(job.id);
      const enabledSchedules = jobSchedules.filter((s) => s.enabled);

      let nextRun = null;
      if (enabledSchedules.length > 0) {
        nextRun = scheduler.describeCron(enabledSchedules[0].cron_expression);
      }

      return {
        ...parseJob(job),
        last_run: lastRun
          ? {
              id: lastRun.id,
              status: lastRun.status,
              started_at: lastRun.started_at,
              finished_at: lastRun.finished_at,
            }
          : null,
        schedule_count: jobSchedules.length,
        next_run: nextRun,
      };
    });

    res.json(enrichedJobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id - Get job details
router.get('/:id', (req, res) => {
  try {
    const job = jobs.getById.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobSchedules = schedules.getByJobId.all(job.id);
    const recentRuns = runs.getByJobId.all(job.id);

    res.json({
      ...parseJob(job),
      schedules: jobSchedules,
      recent_runs: recentRuns,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs - Create job
router.post('/', (req, res) => {
  try {
    const { name, description, job_type, steps, env_vars } = req.body;

    if (!name || !env_vars) {
      return res.status(400).json({ error: 'Name and env_vars are required' });
    }

    // Validate steps
    const validSteps = steps && Array.isArray(steps) && steps.length > 0
      ? steps.filter(s => DEFAULT_STEPS.includes(s))
      : DEFAULT_STEPS;

    const result = jobs.create.run({
      name,
      description: description || null,
      job_type: job_type || 'full',
      steps: JSON.stringify(validSteps),
      env_vars: JSON.stringify(env_vars),
    });

    const newJob = jobs.getById.get(result.lastInsertRowid);
    res.status(201).json(parseJob(newJob));
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ error: 'Job name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/jobs/:id - Update job
router.put('/:id', (req, res) => {
  try {
    const job = jobs.getById.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const { name, description, job_type, steps, env_vars } = req.body;

    // Validate steps if provided
    let stepsJson = job.steps;
    if (steps !== undefined) {
      const validSteps = Array.isArray(steps) && steps.length > 0
        ? steps.filter(s => DEFAULT_STEPS.includes(s))
        : DEFAULT_STEPS;
      stepsJson = JSON.stringify(validSteps);
    }

    jobs.update.run({
      id: req.params.id,
      name: name || job.name,
      description: description !== undefined ? description : job.description,
      job_type: job_type || job.job_type,
      steps: stepsJson,
      env_vars: env_vars ? JSON.stringify(env_vars) : job.env_vars,
    });

    const updatedJob = jobs.getById.get(req.params.id);
    res.json(parseJob(updatedJob));
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ error: 'Job name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/jobs/:id - Delete job
router.delete('/:id', (req, res) => {
  try {
    const job = jobs.getById.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Remove associated schedules from scheduler
    const jobSchedules = schedules.getByJobId.all(job.id);
    for (const schedule of jobSchedules) {
      scheduler.removeSchedule(schedule.id);
    }

    jobs.delete.run(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
