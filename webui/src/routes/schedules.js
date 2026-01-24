const express = require('express');
const { jobs, schedules } = require('../db');
const scheduler = require('../scheduler');

const router = express.Router();

// GET /api/jobs/:id/schedules - List schedules for job
router.get('/jobs/:id/schedules', (req, res) => {
  try {
    const job = jobs.getById.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const jobSchedules = schedules.getByJobId.all(req.params.id);

    // Add human-readable description
    const enrichedSchedules = jobSchedules.map((s) => ({
      ...s,
      description: scheduler.describeCron(s.cron_expression),
    }));

    res.json(enrichedSchedules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/schedules - Add schedule to job
router.post('/jobs/:id/schedules', (req, res) => {
  try {
    const job = jobs.getById.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const { cron_expression, enabled = true } = req.body;

    if (!cron_expression) {
      return res.status(400).json({ error: 'cron_expression is required' });
    }

    if (!scheduler.validateCron(cron_expression)) {
      return res.status(400).json({ error: 'Invalid cron expression' });
    }

    const result = schedules.create.run({
      job_id: req.params.id,
      cron_expression,
      enabled: enabled ? 1 : 0,
    });

    const newSchedule = schedules.getById.get(result.lastInsertRowid);

    // Add to scheduler if enabled
    if (enabled) {
      scheduler.addSchedule({
        ...newSchedule,
        job_id: job.id,
        job_name: job.name,
        job_type: job.job_type,
        env_vars: job.env_vars,
      });
    }

    res.status(201).json({
      ...newSchedule,
      description: scheduler.describeCron(newSchedule.cron_expression),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/schedules/:id - Update schedule
router.put('/:id', (req, res) => {
  try {
    const schedule = schedules.getById.get(req.params.id);
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    const { cron_expression, enabled } = req.body;

    const newCron = cron_expression || schedule.cron_expression;
    const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : schedule.enabled;

    if (cron_expression && !scheduler.validateCron(cron_expression)) {
      return res.status(400).json({ error: 'Invalid cron expression' });
    }

    schedules.update.run({
      id: req.params.id,
      cron_expression: newCron,
      enabled: newEnabled,
    });

    const updatedSchedule = schedules.getById.get(req.params.id);
    const job = jobs.getById.get(updatedSchedule.job_id);

    // Update scheduler
    scheduler.updateSchedule({
      ...updatedSchedule,
      job_name: job?.name || 'Unknown',
      job_type: job?.job_type,
      env_vars: job?.env_vars,
    });

    res.json({
      ...updatedSchedule,
      description: scheduler.describeCron(updatedSchedule.cron_expression),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/schedules/:id - Delete schedule
router.delete('/:id', (req, res) => {
  try {
    const schedule = schedules.getById.get(req.params.id);
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    scheduler.removeSchedule(schedule.id);
    schedules.delete.run(req.params.id);

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/schedules/validate - Validate cron expression
router.get('/validate', (req, res) => {
  const { cron } = req.query;

  if (!cron) {
    return res.status(400).json({ error: 'cron query parameter is required' });
  }

  const valid = scheduler.validateCron(cron);
  const description = valid ? scheduler.describeCron(cron) : null;

  res.json({ valid, description });
});

module.exports = router;
