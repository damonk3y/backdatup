const cron = require('node-cron');
const { schedules, jobs } = require('./db');
const { executeJob } = require('./executor');

// Map of schedule ID -> cron task
const scheduledTasks = new Map();

function loadSchedules() {
  console.log('[Scheduler] Loading enabled schedules...');

  // Stop all existing tasks
  for (const [id, task] of scheduledTasks) {
    task.stop();
    scheduledTasks.delete(id);
  }

  // Load and start enabled schedules
  const enabledSchedules = schedules.getAllEnabled.all();

  for (const schedule of enabledSchedules) {
    scheduleTask(schedule);
  }

  console.log(`[Scheduler] Loaded ${enabledSchedules.length} schedules`);
}

function scheduleTask(schedule) {
  if (!cron.validate(schedule.cron_expression)) {
    console.error(`[Scheduler] Invalid cron expression for schedule ${schedule.id}: ${schedule.cron_expression}`);
    return false;
  }

  const task = cron.schedule(schedule.cron_expression, async () => {
    console.log(`[Scheduler] Running scheduled job: ${schedule.job_name} (schedule ${schedule.id})`);

    const job = jobs.getById.get(schedule.job_id);
    if (!job) {
      console.error(`[Scheduler] Job ${schedule.job_id} not found for schedule ${schedule.id}`);
      return;
    }

    try {
      await executeJob(job, schedule.id);
      console.log(`[Scheduler] Completed job: ${schedule.job_name}`);
    } catch (err) {
      console.error(`[Scheduler] Failed job: ${schedule.job_name}`, err);
    }
  });

  scheduledTasks.set(schedule.id, task);
  console.log(`[Scheduler] Scheduled: ${schedule.job_name} - ${schedule.cron_expression}`);
  return true;
}

function addSchedule(schedule) {
  if (schedule.enabled) {
    const fullSchedule = {
      ...schedule,
      job_name: jobs.getById.get(schedule.job_id)?.name || 'Unknown',
    };
    return scheduleTask(fullSchedule);
  }
  return true;
}

function removeSchedule(scheduleId) {
  const task = scheduledTasks.get(scheduleId);
  if (task) {
    task.stop();
    scheduledTasks.delete(scheduleId);
  }
}

function updateSchedule(schedule) {
  removeSchedule(schedule.id);
  if (schedule.enabled) {
    const fullSchedule = {
      ...schedule,
      job_name: jobs.getById.get(schedule.job_id)?.name || 'Unknown',
    };
    return scheduleTask(fullSchedule);
  }
  return true;
}

function getNextRun(cronExpression) {
  if (!cron.validate(cronExpression)) {
    return null;
  }

  // Parse cron and calculate next run
  // node-cron doesn't expose next run time, so we'll calculate it manually
  const parts = cronExpression.split(' ');
  if (parts.length < 5) return null;

  // Return a human-readable description instead
  return describeCron(cronExpression);
}

function describeCron(expression) {
  const parts = expression.split(' ');
  if (parts.length < 5) return expression;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (minute === '*' && hour === '*') {
    return 'Every minute';
  }

  if (hour === '*') {
    return `Every hour at minute ${minute}`;
  }

  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Daily at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  if (dayOfWeek !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = days[parseInt(dayOfWeek)] || dayOfWeek;
    return `${dayName} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  return expression;
}

function validateCron(expression) {
  return cron.validate(expression);
}

module.exports = {
  loadSchedules,
  addSchedule,
  removeSchedule,
  updateSchedule,
  getNextRun,
  describeCron,
  validateCron,
};
