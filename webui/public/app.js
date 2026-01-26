// API helpers
async function api(endpoint, options = {}) {
  const res = await fetch(`/api${endpoint}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  if (res.status === 204) return null;
  return res.json();
}

// State
let jobs = [];
let allRuns = [];
let currentJobId = null;
let pollInterval = null;

const ALL_STEPS = ['backup', 'persist', 'cleanup'];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  loadData();
  startPolling();

  document.getElementById('btn-new-job').addEventListener('click', openNewJobModal);
  document.getElementById('job-form').addEventListener('submit', saveJob);
  document.getElementById('schedule-form').addEventListener('submit', saveSchedule);
  document.getElementById('cron-expression').addEventListener('input', validateCron);
});

// Tab navigation
let activeTab = 'activity';

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchToTab(tab.dataset.tab);
    });
  });

  // Restore tab from URL query param
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  if (tab && (tab === 'activity' || tab === 'jobs')) {
    switchToTab(tab);
  }

  document.getElementById('breadcrumb-back').addEventListener('click', () => {
    closeLogViewer();
  });
}

function switchToTab(tabId) {
  activeTab = tabId;

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  document.querySelector(`.tab[data-tab="${tabId}"]`).classList.add('active');
  document.getElementById(`tab-${tabId}`).classList.add('active');

  // Persist tab in URL
  const url = new URL(window.location);
  url.searchParams.set('tab', tabId);
  history.replaceState(null, '', url);
}

function showBreadcrumb(parentLabel, currentLabel) {
  document.getElementById('tabs-nav').classList.add('hidden');
  document.getElementById('breadcrumb').classList.remove('hidden');
  document.getElementById('breadcrumb-parent').textContent = parentLabel;
  document.getElementById('breadcrumb-current').textContent = currentLabel;
}

function hideBreadcrumb() {
  document.getElementById('breadcrumb').classList.add('hidden');
  document.getElementById('tabs-nav').classList.remove('hidden');
}

// Polling for active runs
function startPolling() {
  pollInterval = setInterval(async () => {
    try {
      const active = await api('/runs/active');
      updateActiveIndicator(active);
      if (active.length > 0) {
        loadData();
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  }, 3000);
}

function updateActiveIndicator(active) {
  const indicator = document.getElementById('active-jobs');
  const count = document.getElementById('active-count');

  if (active.length > 0) {
    indicator.classList.remove('hidden');
    count.textContent = active.length;
  } else {
    indicator.classList.add('hidden');
  }
}

// Load all data
async function loadData() {
  try {
    jobs = await api('/jobs');
    await loadAllRuns();
    updateStats();
    renderActivityFeed();
    renderJobsTable();
  } catch (err) {
    console.error('Load data error:', err);
  }
}

// Load runs for all jobs
async function loadAllRuns() {
  allRuns = [];
  for (const job of jobs) {
    try {
      const runs = await api(`/jobs/${job.id}/runs`);
      runs.forEach(run => {
        run.job_name = job.name;
        run.job_type = job.job_type;
      });
      allRuns.push(...runs);
    } catch (err) {
      console.error(`Error loading runs for job ${job.id}:`, err);
    }
  }
  // Sort by date, newest first
  allRuns.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
}

// Update stats
function updateStats() {
  // Total jobs
  document.getElementById('stat-total-jobs').textContent = jobs.length;

  // Runs in last 24h
  const now = new Date();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const recentRuns = allRuns.filter(r => new Date(r.started_at) > dayAgo);
  document.getElementById('stat-runs-today').textContent = recentRuns.length;

  // Success rate
  const completedRuns = allRuns.filter(r => r.status !== 'running');
  if (completedRuns.length > 0) {
    const successRuns = completedRuns.filter(r => r.status === 'success');
    const rate = Math.round((successRuns.length / completedRuns.length) * 100);
    document.getElementById('stat-success-rate').textContent = `${rate}%`;
  } else {
    document.getElementById('stat-success-rate').textContent = '-';
  }

  // Last success
  const lastSuccess = allRuns.find(r => r.status === 'success');
  if (lastSuccess) {
    document.getElementById('stat-last-success').textContent = formatRelativeTime(lastSuccess.started_at);
  } else {
    document.getElementById('stat-last-success').textContent = '-';
  }
}

// Render activity feed
function renderActivityFeed() {
  const container = document.getElementById('activity-feed');

  if (allRuns.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No activity yet</h3>
        <p>Run a backup job to see activity here.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = allRuns.slice(0, 20).map(run => {
    const icon = getStatusIcon(run.status);
    const duration = run.finished_at
      ? formatDuration(new Date(run.started_at), new Date(run.finished_at))
      : '-';

    return `
      <div class="activity-item" onclick="showRunOutput(${run.id})">
        <span class="activity-icon ${run.status}">${icon}</span>
        <div class="activity-info">
          <div class="activity-job">${escapeHtml(run.job_name)}</div>
          <div class="activity-meta">${getJobTypeLabel(run.job_type)}</div>
        </div>
        <span class="activity-status ${run.status}">${run.status}</span>
        <span class="activity-duration">${duration}</span>
        <span class="activity-time">${formatRelativeTime(run.started_at)}</span>
      </div>
    `;
  }).join('');
}

// Render jobs table
function renderJobsTable() {
  const tbody = document.getElementById('jobs-tbody');

  if (jobs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state">
            <h3>No backup jobs configured</h3>
            <p>Create your first backup job to get started.</p>
            <button class="btn btn-primary" onclick="openNewJobModal()">+ New Job</button>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = jobs.map(job => {
    // Get runs for this job
    const jobRuns = allRuns.filter(r => r.job_id === job.id);
    const lastRun = jobRuns[0];

    // Calculate success rate
    const completedRuns = jobRuns.filter(r => r.status !== 'running');
    let successRate = '-';
    let rateClass = '';
    if (completedRuns.length > 0) {
      const successCount = completedRuns.filter(r => r.status === 'success').length;
      const rate = Math.round((successCount / completedRuns.length) * 100);
      successRate = `${rate}%`;
      rateClass = rate >= 90 ? 'good' : rate >= 70 ? 'warning' : 'bad';
    }

    // Last run display
    let lastRunHtml = '<span class="job-type">Never</span>';
    if (lastRun) {
      const icon = getStatusIcon(lastRun.status);
      lastRunHtml = `
        <div class="job-last-run">
          <span class="status-icon ${lastRun.status}">${icon}</span>
          <span>${formatRelativeTime(lastRun.started_at)}</span>
        </div>
      `;
    }

    // Next scheduled
    const nextScheduled = job.next_run || '<span class="job-type">No schedule</span>';

    const isRunning = lastRun?.status === 'running';

    return `
      <tr>
        <td>
          <span class="job-name">
            <a class="job-name-link" onclick="showJobDetail(${job.id})" title="View details & runs">${escapeHtml(job.name)}</a>
          </span>
        </td>
        <td><span class="job-type">${getJobTypeLabel(job.job_type)}</span></td>
        <td>${lastRunHtml}</td>
        <td class="job-schedule">${nextScheduled}</td>
        <td><span class="job-rate ${rateClass}">${successRate}</span></td>
        <td>
          <div class="job-actions">
            <button class="btn btn-sm btn-success" onclick="runJob(${job.id})" ${isRunning ? 'disabled' : ''}>
              ${isRunning ? '...' : 'Run'}
            </button>
            <button class="btn btn-sm" onclick="editJob(${job.id})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteJob(${job.id})">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Show job detail modal
async function showJobDetail(jobId) {
  try {
    const job = await api(`/jobs/${jobId}`);
    const schedules = await api(`/jobs/${jobId}/schedules`);
    const runs = await api(`/jobs/${jobId}/runs`);

    document.getElementById('job-detail-title').textContent = job.name;

    // Calculate stats
    const completedRuns = runs.filter(r => r.status !== 'running');
    let successRate = '-';
    if (completedRuns.length > 0) {
      const successCount = completedRuns.filter(r => r.status === 'success').length;
      successRate = `${Math.round((successCount / completedRuns.length) * 100)}% (${successCount}/${completedRuns.length})`;
    }

    const content = document.getElementById('job-detail-content');
    content.innerHTML = `
      <div class="job-detail-section">
        <h4>Overview</h4>
        <div class="job-detail-grid">
          <div class="job-detail-item">
            <div class="job-detail-label">Type</div>
            <div class="job-detail-value">${getJobTypeLabel(job.job_type)}</div>
          </div>
          <div class="job-detail-item">
            <div class="job-detail-label">Steps</div>
            <div class="job-detail-value">${formatSteps(job.steps)}</div>
          </div>
          <div class="job-detail-item">
            <div class="job-detail-label">Success Rate</div>
            <div class="job-detail-value">${successRate}</div>
          </div>
          <div class="job-detail-item">
            <div class="job-detail-label">Total Runs</div>
            <div class="job-detail-value">${runs.length}</div>
          </div>
        </div>
      </div>

      <div class="job-detail-section">
        <h4>Schedules</h4>
        ${schedules.length === 0
          ? '<p style="color: var(--text-muted); font-size: 0.875rem;">No schedules configured</p>'
          : `<div class="schedules-list">
              ${schedules.map(s => `
                <div class="schedule-row">
                  <div>
                    <span class="schedule-cron">${escapeHtml(s.cron_expression)}</span>
                    <span class="schedule-desc">${escapeHtml(s.description || '')}</span>
                  </div>
                  <div class="schedule-actions">
                    <label class="toggle-sm">
                      <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="toggleSchedule(${s.id}, this.checked)">
                      <span class="slider"></span>
                    </label>
                    <button class="btn btn-sm btn-danger btn-icon" onclick="deleteSchedule(${s.id})">&times;</button>
                  </div>
                </div>
              `).join('')}
            </div>`
        }
        <button class="btn btn-sm" style="margin-top: 12px;" onclick="closeJobDetailModal(); openScheduleModal(${job.id})">+ Add Schedule</button>
      </div>

      <div class="job-detail-section">
        <h4>Recent Runs</h4>
        ${runs.length === 0
          ? '<p style="color: var(--text-muted); font-size: 0.875rem;">No runs yet</p>'
          : `<div class="runs-list">
              ${runs.slice(0, 10).map(r => {
                const duration = r.finished_at
                  ? formatDuration(new Date(r.started_at), new Date(r.finished_at))
                  : '-';
                return `
                  <div class="run-row" onclick="showRunOutput(${r.id})">
                    <span class="run-status status-icon ${r.status}">${getStatusIcon(r.status)}</span>
                    <span class="run-time">${formatTime(r.started_at)}</span>
                    <span class="run-duration">${duration}</span>
                  </div>
                `;
              }).join('')}
            </div>`
        }
      </div>

      <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border);">
        <button class="btn btn-success" onclick="closeJobDetailModal(); runJob(${job.id})">Run Now</button>
        <button class="btn" onclick="closeJobDetailModal(); editJob(${job.id})">Edit Job</button>
      </div>
    `;

    document.getElementById('job-detail-modal').classList.remove('hidden');
  } catch (err) {
    alert('Error loading job details: ' + err.message);
  }
}

function closeJobDetailModal() {
  document.getElementById('job-detail-modal').classList.add('hidden');
}

// Job CRUD
function openNewJobModal() {
  currentJobId = null;
  document.getElementById('modal-title').textContent = 'New Job';
  document.getElementById('job-form').reset();
  document.getElementById('job-id').value = '';

  // Reset steps to all checked
  setStepsCheckboxes(ALL_STEPS);

  // Add default env vars
  const container = document.getElementById('env-vars-container');
  container.innerHTML = '';

  const defaultVars = [
    'RAID_PATH',
    'ENVIRONMENT',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_DB',
    'MINIO_ENDPOINT',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
  ];

  defaultVars.forEach(key => addEnvVar(key, ''));

  document.getElementById('job-modal').classList.remove('hidden');
}

async function editJob(jobId) {
  try {
    const job = await api(`/jobs/${jobId}`);
    currentJobId = jobId;

    document.getElementById('modal-title').textContent = 'Edit Job';
    document.getElementById('job-id').value = job.id;
    document.getElementById('job-name').value = job.name;
    document.getElementById('job-description').value = job.description || '';
    document.getElementById('job-type').value = job.job_type;

    // Set steps checkboxes
    setStepsCheckboxes(job.steps || ALL_STEPS);

    const container = document.getElementById('env-vars-container');
    container.innerHTML = '';

    Object.entries(job.env_vars).forEach(([key, value]) => {
      addEnvVar(key, value);
    });

    document.getElementById('job-modal').classList.remove('hidden');
  } catch (err) {
    alert('Error loading job: ' + err.message);
  }
}

async function saveJob(e) {
  e.preventDefault();

  const nameInput = document.getElementById('job-name');
  const name = nameInput.value.trim();

  if (!name) {
    alert('Please enter a job name');
    nameInput.focus();
    return;
  }

  const envVars = {};
  document.querySelectorAll('.env-var-row').forEach(row => {
    const key = row.querySelector('.env-key').value.trim();
    const value = row.querySelector('.env-value').value;
    if (key) {
      envVars[key] = value;
    }
  });

  const steps = getSelectedSteps();
  if (steps.length === 0) {
    alert('Please select at least one workflow step');
    return;
  }

  const data = {
    name: name,
    description: document.getElementById('job-description').value.trim(),
    job_type: document.getElementById('job-type').value,
    steps: steps,
    env_vars: envVars,
  };

  try {
    if (currentJobId) {
      await api(`/jobs/${currentJobId}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      await api('/jobs', { method: 'POST', body: JSON.stringify(data) });
    }
    closeModal();
    loadData();
  } catch (err) {
    alert('Error saving job: ' + err.message);
  }
}

async function deleteJob(jobId) {
  if (!confirm('Delete this job? All schedules and run history will be deleted.')) {
    return;
  }

  try {
    await api(`/jobs/${jobId}`, { method: 'DELETE' });
    loadData();
  } catch (err) {
    alert('Error deleting job: ' + err.message);
  }
}

async function runJob(jobId) {
  try {
    await api(`/jobs/${jobId}/run`, { method: 'POST' });
    loadData();
  } catch (err) {
    alert('Error running job: ' + err.message);
  }
}

// Steps helpers
function setStepsCheckboxes(steps) {
  ALL_STEPS.forEach(step => {
    const checkbox = document.getElementById(`step-${step}`);
    if (checkbox) {
      checkbox.checked = steps.includes(step);
    }
  });
}

function getSelectedSteps() {
  const steps = [];
  ALL_STEPS.forEach(step => {
    const checkbox = document.getElementById(`step-${step}`);
    if (checkbox && checkbox.checked) {
      steps.push(step);
    }
  });
  return steps;
}

function formatSteps(steps) {
  if (!steps || steps.length === 0) return 'No steps';
  if (steps.length === ALL_STEPS.length) return 'Full workflow';
  return steps.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' → ');
}

// Schedules
function openScheduleModal(jobId) {
  document.getElementById('schedule-modal-title').textContent = 'Add Schedule';
  document.getElementById('schedule-form').reset();
  document.getElementById('schedule-job-id').value = jobId;
  document.getElementById('schedule-id').value = '';
  document.getElementById('cron-preview').textContent = '';
  document.getElementById('schedule-modal').classList.remove('hidden');
}

async function saveSchedule(e) {
  e.preventDefault();

  const jobId = document.getElementById('schedule-job-id').value;
  const scheduleId = document.getElementById('schedule-id').value;
  const data = {
    cron_expression: document.getElementById('cron-expression').value,
    enabled: document.getElementById('schedule-enabled').checked,
  };

  try {
    if (scheduleId) {
      await api(`/schedules/${scheduleId}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      await api(`/jobs/${jobId}/schedules`, { method: 'POST', body: JSON.stringify(data) });
    }
    closeScheduleModal();
    loadData();
  } catch (err) {
    alert('Error saving schedule: ' + err.message);
  }
}

async function toggleSchedule(scheduleId, enabled) {
  try {
    await api(`/schedules/${scheduleId}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    loadData();
  } catch (err) {
    alert('Error updating schedule: ' + err.message);
    loadData();
  }
}

async function deleteSchedule(scheduleId) {
  if (!confirm('Delete this schedule?')) return;

  try {
    await api(`/schedules/${scheduleId}`, { method: 'DELETE' });
    loadData();
  } catch (err) {
    alert('Error deleting schedule: ' + err.message);
  }
}

async function validateCron(e) {
  const cron = e.target.value;
  const preview = document.getElementById('cron-preview');

  if (!cron) {
    preview.textContent = '';
    return;
  }

  try {
    const result = await api(`/schedules/validate?cron=${encodeURIComponent(cron)}`);
    if (result.valid) {
      preview.textContent = result.description;
      preview.style.color = 'var(--success)';
    } else {
      preview.textContent = 'Invalid cron expression';
      preview.style.color = 'var(--error)';
    }
  } catch (err) {
    preview.textContent = 'Error validating';
    preview.style.color = 'var(--error)';
  }
}

// Inline log viewer
let currentRunId = null;
let logRefreshInterval = null;
let rawLogOutput = '';

function showRunOutput(runId) {
  currentRunId = runId;

  // Close any open modals
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));

  // Find run info for breadcrumb
  const run = allRuns.find(r => r.id === runId);
  const parentLabel = activeTab === 'jobs' ? 'Jobs' : 'Activity';
  const currentLabel = run ? `Run #${run.id} - ${run.job_name}` : `Run #${runId}`;

  // Show breadcrumb, hide tab content, show log viewer
  showBreadcrumb(parentLabel, currentLabel);
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.getElementById('log-viewer').classList.remove('hidden');

  loadInlineLogs();
}

function closeLogViewer() {
  // Stop refresh
  if (logRefreshInterval) {
    clearInterval(logRefreshInterval);
    logRefreshInterval = null;
  }
  currentRunId = null;
  rawLogOutput = '';

  // Hide log viewer, restore breadcrumb to tabs, restore active tab
  document.getElementById('log-viewer').classList.add('hidden');
  hideBreadcrumb();
  switchToTab(activeTab);
}

async function loadInlineLogs() {
  if (!currentRunId) return;

  try {
    const res = await fetch(`/api/runs/${currentRunId}`);
    if (!res.ok) throw new Error('Failed to load run');

    const run = await res.json();
    rawLogOutput = run.output || '';

    // Update header
    document.getElementById('log-viewer-title').textContent = `Run #${run.id} - ${run.job_name}`;

    const badge = document.getElementById('log-viewer-badge');
    badge.textContent = run.status;
    badge.className = `status-badge-inline status-${run.status}`;

    const startTime = new Date(run.started_at).toLocaleString();
    const endTime = run.finished_at ? new Date(run.finished_at).toLocaleString() : 'In progress...';
    document.getElementById('log-viewer-meta').textContent = `Started: ${startTime} | Ended: ${endTime}`;

    // Show/hide cancel button
    document.getElementById('log-cancel-btn').style.display = run.status === 'running' ? 'inline-flex' : 'none';

    // Render logs
    document.getElementById('log-viewer-output').innerHTML = ansiToHtml(run.output || 'No output yet...');

    // Auto-refresh if running
    if (run.status === 'running') {
      if (!logRefreshInterval) {
        logRefreshInterval = setInterval(loadInlineLogs, 2000);
      }
    } else {
      if (logRefreshInterval) {
        clearInterval(logRefreshInterval);
        logRefreshInterval = null;
      }
    }
  } catch (err) {
    document.getElementById('log-viewer-output').innerHTML = `<div class="error" style="color: var(--error); padding: 40px; text-align: center;">Error: ${err.message}</div>`;
  }
}

function refreshInlineLogs() {
  loadInlineLogs();
}

async function cancelInlineRun() {
  if (!confirm('Are you sure you want to cancel this run?')) return;

  try {
    const res = await fetch(`/api/runs/${currentRunId}/cancel`, { method: 'POST' });
    if (res.ok) {
      loadInlineLogs();
    } else {
      const err = await res.json();
      alert('Failed to cancel: ' + err.error);
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function copyRawLogs() {
  const btn = document.querySelector('[onclick="copyRawLogs()"]');
  const original = btn ? btn.textContent : '';

  function showCopied() {
    if (btn) {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(rawLogOutput).then(showCopied).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }

  function fallbackCopy() {
    const textarea = document.createElement('textarea');
    textarea.value = rawLogOutput;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showCopied();
  }
}

// ANSI to HTML converter
function ansiToHtml(text) {
  if (!text) return '';

  const ansiColors = {
    '30': 'ansi-black', '31': 'ansi-red', '32': 'ansi-green', '33': 'ansi-yellow',
    '34': 'ansi-blue', '35': 'ansi-magenta', '36': 'ansi-cyan', '37': 'ansi-white',
    '90': 'ansi-bright-black', '91': 'ansi-bright-red', '92': 'ansi-bright-green',
    '93': 'ansi-bright-yellow', '94': 'ansi-bright-blue', '95': 'ansi-bright-magenta',
    '96': 'ansi-bright-cyan', '97': 'ansi-bright-white',
  };

  const ansiBgColors = {
    '40': 'ansi-bg-black', '41': 'ansi-bg-red', '42': 'ansi-bg-green', '43': 'ansi-bg-yellow',
    '44': 'ansi-bg-blue', '45': 'ansi-bg-magenta', '46': 'ansi-bg-cyan', '47': 'ansi-bg-white',
  };

  const ansiStyles = {
    '1': 'ansi-bold', '2': 'ansi-dim', '3': 'ansi-italic', '4': 'ansi-underline',
  };

  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  let currentClasses = [];

  html = html.replace(/\x1b\[([0-9;]*)m/g, (match, codes) => {
    if (!codes || codes === '0') {
      const closeSpans = currentClasses.length > 0 ? '</span>' : '';
      currentClasses = [];
      return closeSpans;
    }

    const codeList = codes.split(';');
    const newClasses = [];

    for (const code of codeList) {
      if (ansiColors[code]) newClasses.push(ansiColors[code]);
      else if (ansiBgColors[code]) newClasses.push(ansiBgColors[code]);
      else if (ansiStyles[code]) newClasses.push(ansiStyles[code]);
    }

    if (newClasses.length > 0) {
      const closeSpans = currentClasses.length > 0 ? '</span>' : '';
      currentClasses = newClasses;
      return closeSpans + `<span class="${newClasses.join(' ')}">`;
    }

    return '';
  });

  if (currentClasses.length > 0) {
    html += '</span>';
  }

  return html;
}

// Env vars
function addEnvVar(key = '', value = '') {
  const container = document.getElementById('env-vars-container');
  const row = document.createElement('div');
  row.className = 'env-var-row';
  row.innerHTML = `
    <input type="text" class="env-key" placeholder="KEY" value="${escapeHtml(key)}">
    <input type="text" class="env-value" placeholder="value" value="${escapeHtml(value)}">
    <button type="button" class="btn-remove" onclick="this.parentElement.remove()">&times;</button>
  `;
  container.appendChild(row);
}

// Modal helpers
function closeModal() {
  document.getElementById('job-modal').classList.add('hidden');
  currentJobId = null;
}

function closeScheduleModal() {
  document.getElementById('schedule-modal').classList.add('hidden');
}

// Close modals on backdrop click - handled by onclick on .modal-backdrop

// Close modals or log viewer on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (currentRunId) {
      closeLogViewer();
    } else {
      document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    }
  }
});

// Utilities
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function formatDuration(start, end) {
  const diff = end - start;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function getStatusIcon(status) {
  switch (status) {
    case 'success': return '✓';
    case 'failed': return '✗';
    case 'running': return '↻';
    default: return '•';
  }
}

function getJobTypeLabel(type) {
  const labels = {
    full: 'Full',
    psql: 'PostgreSQL',
    minio: 'MinIO',
  };
  return labels[type] || type;
}
