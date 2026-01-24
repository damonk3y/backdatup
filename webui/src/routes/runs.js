const express = require('express');
const { jobs, runs } = require('../db');
const { executeJob, cancelRun, isRunActive } = require('../executor');

const router = express.Router();

// POST /api/jobs/:id/run - Manually trigger job
router.post('/jobs/:id/run', async (req, res) => {
  try {
    const job = jobs.getById.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if job is already running
    const activeRuns = runs.getActive.all();
    const jobRunning = activeRuns.some((r) => r.job_id === job.id);
    if (jobRunning) {
      return res.status(409).json({ error: 'Job is already running' });
    }

    // Start execution asynchronously
    executeJob(job, null);

    // Return immediately with the run info
    const latestRun = runs.getLastByJobId.get(job.id);
    res.status(202).json({
      message: 'Job started',
      run: latestRun,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id/runs - Get run history for job
router.get('/jobs/:id/runs', (req, res) => {
  try {
    const job = jobs.getById.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobRuns = runs.getByJobId.all(req.params.id);
    res.json(jobRuns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/runs/active - Get currently running jobs
router.get('/runs/active', (req, res) => {
  try {
    const activeRuns = runs.getActive.all();

    // Enrich with job info
    const enrichedRuns = activeRuns.map((run) => {
      const job = jobs.getById.get(run.job_id);
      return {
        ...run,
        job_name: job?.name || 'Unknown',
        job_type: job?.job_type || 'unknown',
      };
    });

    res.json(enrichedRuns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/runs/:id - Get run details with output
router.get('/runs/:id', (req, res) => {
  try {
    const run = runs.getById.get(req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }

    const job = jobs.getById.get(run.job_id);
    res.json({
      ...run,
      job_name: job?.name || 'Unknown',
      job_type: job?.job_type || 'unknown',
      is_active: isRunActive(run.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/runs/:id/cancel - Cancel a running job
router.post('/runs/:id/cancel', (req, res) => {
  try {
    const run = runs.getById.get(req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }

    if (run.status !== 'running') {
      return res.status(400).json({ error: 'Run is not active' });
    }

    const cancelled = cancelRun(run.id);
    if (cancelled) {
      res.json({ message: 'Run cancelled' });
    } else {
      res.status(400).json({ error: 'Could not cancel run' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
