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
let sshEndpoints = [];
let currentJobId = null;
let currentEndpointId = null;
let pollInterval = null;
let activityPage = 0;
const ACTIVITY_PAGE_SIZE = 25;
const VALID_TABS = ['activity', 'jobs', 'ssh-endpoints'];

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
  document.getElementById('btn-new-endpoint').addEventListener('click', openNewEndpointModal);
  document.getElementById('endpoint-form').addEventListener('submit', saveEndpoint);

  // Event delegation for download buttons in the backups browser (robust, no inline onclick)
  const browserList = document.getElementById('backups-browser-list');
  if (browserList) {
    browserList.addEventListener('click', (e) => {
      const btn = e.target.closest('.backup-download');
      if (btn) {
        e.stopImmediatePropagation();
        const jid = parseInt(btn.dataset.jobId, 10);
        const backupName = btn.dataset.backupName;
        if (jid && backupName) {
          downloadBackup(jid, backupName);
        }
      }
    });
  }

  // Wire the browser search input (removed inline oninput for consistency with delegation pattern)
  const browserSearch = document.getElementById('backups-browser-search');
  if (browserSearch) {
    browserSearch.addEventListener('input', (e) => {
      onBackupsBrowserSearch(e.target.value);
    });
  }

  // Delegation for the "Backups" action buttons (table + job detail) — consistent with download fix
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.js-open-backups');
    if (btn) {
      e.stopImmediatePropagation();
      const jid = parseInt(btn.dataset.jobId, 10);
      if (jid) {
        // Close any open job detail modal first so we don't stack
        const detailModal = document.getElementById('job-detail-modal');
        if (detailModal) detailModal.classList.add('hidden');
        openBackupsBrowser(jid);
      }
    }
  });
});

// Tab navigation + history-aware routing
let activeTab = 'activity';

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      navigateToTab(tab.dataset.tab);
    });
  });

  // History support: browser back/forward now works for tabs and run logs
  window.addEventListener('popstate', syncRouteFromURL);

  // Initial route restore (supports ?tab=jobs and ?tab=activity&run=123)
  syncRouteFromURL();

  document.getElementById('breadcrumb-back').addEventListener('click', () => {
    closeLogViewer();
  });
}

// User-initiated tab switch: push history entry so back/forward works
function navigateToTab(tabId) {
  if (!VALID_TABS.includes(tabId)) return;

  const url = new URL(window.location);
  url.searchParams.set('tab', tabId);
  url.searchParams.delete('run'); // leaving the current tab context clears any open run log
  history.pushState(null, '', url);

  syncRouteFromURL();
}

// Applies whatever the current URL says (tab + optional run).
// This is the single source of truth for main navigation state.
function syncRouteFromURL() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab') || 'activity';
  const runIdParam = params.get('run');

  if (VALID_TABS.includes(tab)) {
    activeTab = tab;

    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    const tabBtn = document.querySelector(`.tab[data-tab="${tab}"]`);
    const tabContent = document.getElementById(`tab-${tab}`);
    if (tabBtn) tabBtn.classList.add('active');
    if (tabContent) tabContent.classList.add('active');
  }

  const runId = runIdParam ? parseInt(runIdParam, 10) : null;

  if (runId) {
    // Show the log viewer on top of the current tab
    showLogViewerChrome();

    // Placeholder until we fetch the real run data
    document.getElementById('breadcrumb-parent').textContent = activeTab === 'jobs' ? 'Jobs' : 'Activity';
    document.getElementById('breadcrumb-current').textContent = `Run #${runId}`;

    currentRunId = runId;
    loadInlineLogs();
  } else {
    hideLogViewerChrome();
    currentRunId = null;
  }
}

function showLogViewerChrome() {
  // Primary navigation (tabs) stays visible at all times — this is the key UX fix.
  // The breadcrumb now acts as a secondary context line under the tabs.
  document.getElementById('breadcrumb').classList.remove('hidden');

  // Hide the main tab content area so the log viewer can take focus
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('log-viewer').classList.remove('hidden');
}

function hideLogViewerChrome() {
  document.getElementById('log-viewer').classList.add('hidden');
  document.getElementById('breadcrumb').classList.add('hidden');

  // Restore the currently active tab's content
  const activeContent = document.getElementById(`tab-${activeTab}`);
  if (activeContent) activeContent.classList.add('active');
}

function showBreadcrumb(parentLabel, currentLabel) {
  // Kept for compatibility with existing showRunOutput calls that pass labels
  document.getElementById('breadcrumb-parent').textContent = parentLabel;
  document.getElementById('breadcrumb-current').textContent = currentLabel;
}

// Legacy name kept for minimal diff — now just cleans the run param via history
function switchToTab(tabId) {
  navigateToTab(tabId);
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
    sshEndpoints = await api('/ssh-endpoints');
    await loadAllRuns();
    updateStats();
    renderActivityFeed();
    renderJobsTable();
    renderJobsSuccessRate();
    renderSshEndpointsTable();
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
  const pagination = document.getElementById('activity-pagination');

  if (allRuns.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No activity yet</h3>
        <p>Run a backup job to see activity here.</p>
      </div>
    `;
    pagination.classList.add('hidden');
    return;
  }

  const totalPages = Math.ceil(allRuns.length / ACTIVITY_PAGE_SIZE);
  if (activityPage >= totalPages) activityPage = totalPages - 1;
  if (activityPage < 0) activityPage = 0;

  const start = activityPage * ACTIVITY_PAGE_SIZE;
  const pageRuns = allRuns.slice(start, start + ACTIVITY_PAGE_SIZE);

  container.innerHTML = pageRuns.map(run => {
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

  // Pagination controls
  if (totalPages > 1) {
    pagination.classList.remove('hidden');
    document.getElementById('page-prev').disabled = activityPage === 0;
    document.getElementById('page-next').disabled = activityPage >= totalPages - 1;
    document.getElementById('page-info').textContent = `Page ${activityPage + 1} of ${totalPages}`;
  } else {
    pagination.classList.add('hidden');
  }
}

function activityPagePrev() {
  if (activityPage > 0) {
    activityPage--;
    renderActivityFeed();
  }
}

function activityPageNext() {
  const totalPages = Math.ceil(allRuns.length / ACTIVITY_PAGE_SIZE);
  if (activityPage < totalPages - 1) {
    activityPage++;
    renderActivityFeed();
  }
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
            <button class="btn btn-sm js-open-backups" data-job-id="${job.id}">Backups</button>
            <button class="btn btn-sm" onclick="editJob(${job.id})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteJob(${job.id})">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Render combined success rate for last 20 runs on Jobs tab
function renderJobsSuccessRate() {
  const container = document.getElementById('jobs-success-summary');
  const recent = allRuns.slice(0, 20);
  const completed = recent.filter(r => r.status !== 'running');

  if (completed.length === 0) {
    container.innerHTML = '';
    return;
  }

  const successCount = completed.filter(r => r.status === 'success').length;
  const rate = Math.round((successCount / completed.length) * 100);
  const rateClass = rate >= 90 ? 'good' : rate >= 70 ? 'warning' : 'bad';

  container.innerHTML = `
    <span class="success-summary-label">Last 20 runs</span>
    <span class="success-summary-rate ${rateClass}">${rate}%</span>
    <span class="success-summary-detail">${successCount}/${completed.length} succeeded</span>
  `;
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

      <div class="job-detail-section">
        <h4>Backups on RAID</h4>
        <p style="color: var(--text-muted); font-size: 0.875rem; margin-bottom: 10px;">
          Persisted backups scoped to this job (filtered by its POSTGRES_DB / environment).
        </p>
        <button class="btn js-open-backups" data-job-id="${job.id}">
          Browse backups on RAID →
        </button>
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

  // Defensive: if a log viewer was somehow left in a weird state, make sure the current tab content is visible
  if (document.getElementById('log-viewer').classList.contains('hidden') === false) {
    // only restore if no run param (i.e. we didn't intend to be in a log)
    const params = new URLSearchParams(window.location.search);
    if (!params.get('run')) {
      hideLogViewerChrome();
    }
  }
}

function downloadBackup(jobId, name) {
  if (!name || !jobId) return;
  const url = `/api/jobs/${jobId}/backups/${encodeURIComponent(name)}/download`;
  const a = document.createElement('a');
  a.href = url;
  a.download = name.endsWith('.tar.gz') ? name : `${name}.tar.gz`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 0);
}

// Shared client-side state for the dedicated backups browser
let backupsSearchTerm = '';
let currentBackupsData = { psql: [], minio: [] };

function renderBackupRow(jobId, b) {
  const niceTime = parseBackupTime(b.name) || new Date(b.mtime).toLocaleString();
  const niceSize = formatBytes(b.size);
  const icon = b.type === 'psql' ? '🐘' : '📦';
  // Use data attributes + event delegation/attachment instead of fragile inline onclick
  // (prevents quoting issues with backup names in generated HTML)
  return `
    <div class="backup-row">
      <span class="backup-icon">${icon}</span>
      <span class="backup-name">${escapeHtml(b.name)}</span>
      <span class="backup-time">${niceTime}</span>
      <span class="backup-size">${niceSize}</span>
      <button class="btn btn-sm backup-download" data-job-id="${jobId}" data-backup-name="${escapeHtml(b.name)}">Download</button>
    </div>
  `;
}

function groupBackups(items) {
  if (!items || items.length === 0) return [];
  const groups = {};
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

  for (const b of items) {
    const d = new Date(b.mtime);
    const key = d.toISOString().slice(0, 10);
    let label = key;
    if (key === today) label = 'Today';
    else if (key === yesterday) label = 'Yesterday';
    else label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    if (!groups[label]) groups[label] = [];
    groups[label].push(b);
  }

  // Order: Today, Yesterday, then chronological remaining
  const ordered = [];
  if (groups['Today']) ordered.push({ label: 'Today', items: groups['Today'] });
  if (groups['Yesterday']) ordered.push({ label: 'Yesterday', items: groups['Yesterday'] });

  const otherKeys = Object.keys(groups).filter(k => k !== 'Today' && k !== 'Yesterday')
    .sort((a, b) => new Date(b) - new Date(a)); // newest first among older

  for (const k of otherKeys) {
    ordered.push({ label: k, items: groups[k] });
  }
  return ordered;
}

function renderFilteredBackups(jobId, data) {
  const container = document.getElementById('job-backups-list');
  if (!container) return;

  const term = (backupsSearchTerm || '').toLowerCase().trim();
  let psql = data.psql || [];
  let minio = data.minio || [];

  if (term) {
    psql = psql.filter(b => b.name.toLowerCase().includes(term));
    minio = minio.filter(b => b.name.toLowerCase().includes(term));
  }

  const total = psql.length + minio.length;
  const scopeLabel = data.psql_prefix ? `for ${escapeHtml(data.psql_prefix)}` : '';

  let html = `
    <div class="backups-controls">
      <div class="backups-meta">
        <span class="backups-count">${total} backup${total === 1 ? '' : 's'}</span>
        ${scopeLabel ? `<span class="backups-scope">${scopeLabel}</span>` : ''}
      </div>
      <input type="search" class="backups-search" placeholder="Filter by name…" value="${escapeHtml(backupsSearchTerm)}" oninput="onBackupsSearchInput(${jobId}, this.value)">
    </div>
  `;

  if (total === 0) {
    const emptyMsg = term
      ? 'No matching backups for this job.'
      : (data.psql_prefix
          ? `No backups found for <strong>${escapeHtml(data.psql_prefix)}</strong> on this RAID_PATH + ENVIRONMENT.<br>Make sure the job has run "persist" at least once.`
          : 'No backups found on RAID for this job\'s configuration.<br>Make sure you have run "persist" at least once.');
    html += `<div class="backups-empty">${emptyMsg}</div>`;
    container.innerHTML = html;
    return;
  }

  html += '<div class="backups-list">';

  if (psql.length > 0) {
    html += `<div class="backups-group-label">PostgreSQL ${scopeLabel ? '· ' + escapeHtml(data.psql_prefix) : ''}</div>`;
    const groups = groupBackups(psql);
    for (const g of groups) {
      html += `<div class="backup-group"><div class="backup-group-head">${g.label}</div>`;
      html += g.items.map(b => renderBackupRow(jobId, b)).join('');
      html += `</div>`;
    }
  }

  if (minio.length > 0) {
    html += `<div class="backups-group-label" style="margin-top:10px;">MinIO</div>`;
    const groups = groupBackups(minio);
    for (const g of groups) {
      html += `<div class="backup-group"><div class="backup-group-head">${g.label}</div>`;
      html += g.items.map(b => renderBackupRow(jobId, b)).join('');
      html += `</div>`;
    }
  }

  html += '</div>';
  html += `<div class="backups-footnote">Files are streamed directly from RAID_PATH. Large PostgreSQL dumps are tar-gzipped on the fly.</div>`;

  container.innerHTML = html;
}

function onBackupsSearchInput(jobId, value) {
  backupsSearchTerm = value || '';
  currentBackupsJobId = jobId;
  // Re-render using the last fetched data (no extra request)
  renderFilteredBackups(jobId, currentBackupsData);
}

async function loadJobBackups(jobId) {
  const container = document.getElementById('job-backups-list');
  if (!container) return;

  backupsSearchTerm = ''; // reset search when explicitly refreshing
  currentBackupsJobId = jobId;
  container.innerHTML = '<div class="loading">Loading backups from RAID...</div>';

  try {
    const data = await api(`/jobs/${jobId}/backups`);
    currentBackupsData = { psql: data.psql || [], minio: data.minio || [] };
    renderFilteredBackups(jobId, data);
  } catch (err) {
    container.innerHTML = `
      <p style="color: var(--error); font-size: 0.875rem;">Failed to list backups: ${escapeHtml(err.message)}</p>
      <button class="btn btn-sm" onclick="loadJobBackups(${jobId})">Retry</button>
    `;
  }
}

// ============================================
// Dedicated Backups Browser (separate modal)
// ============================================

let backupsBrowserJobId = null;

async function openBackupsBrowser(jobId) {
  try {
    // Close other modals + any open log viewer (don't want to leave the user in a sub-state)
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    hideLogViewerChrome();
    currentRunId = null;

    // Also clean the run param from URL so a refresh doesn't bring back the log
    const url = new URL(window.location);
    url.searchParams.delete('run');
    history.replaceState(null, '', url);

    backupsSearchTerm = '';
    backupsBrowserJobId = jobId;

    const titleEl = document.getElementById('backups-modal-title');
    const subtitleEl = document.getElementById('backups-modal-subtitle');
    const listEl = document.getElementById('backups-browser-list');
    const searchEl = document.getElementById('backups-browser-search');
    const countEl = document.getElementById('backups-browser-count');

    titleEl.textContent = 'Backups on RAID';
    subtitleEl.textContent = '';
    countEl.textContent = '';
    listEl.innerHTML = '<div class="loading">Loading backups from RAID...</div>';
    if (searchEl) searchEl.value = '';

    document.getElementById('backups-modal').classList.remove('hidden');

    const data = await api(`/jobs/${jobId}/backups`);
    currentBackupsData = { psql: data.psql || [], minio: data.minio || [] };

    // Populate header from the list response (already includes job_name, psql_prefix, environment)
    titleEl.textContent = `Backups — ${data.job_name || 'Job ' + jobId}`;

    const env = data.environment || '';
    const prefix = data.psql_prefix ? ` · ${data.psql_prefix}` : '';
    subtitleEl.textContent = env ? `Environment: ${env}${prefix}` : (prefix ? prefix.slice(2) : '');

    renderBackupsBrowserList(jobId, data);
  } catch (err) {
    const listEl = document.getElementById('backups-browser-list');
    if (listEl) {
      listEl.innerHTML = `
        <p style="color: var(--error); font-size: 0.875rem; padding: 20px;">Failed to load backups: ${escapeHtml(err.message)}</p>
        <button class="btn btn-sm js-open-backups" data-job-id="${jobId}">Retry</button>
      `;
    }
  }
}

function closeBackupsBrowser() {
  document.getElementById('backups-modal').classList.add('hidden');
  backupsBrowserJobId = null;
  backupsSearchTerm = '';
  // leave currentBackupsData as-is (cheap)
}

function refreshBackupsBrowser() {
  if (!backupsBrowserJobId) return;
  const listEl = document.getElementById('backups-browser-list');
  if (listEl) listEl.innerHTML = '<div class="loading">Refreshing...</div>';
  backupsSearchTerm = '';
  const searchEl = document.getElementById('backups-browser-search');
  if (searchEl) searchEl.value = '';

  api(`/jobs/${backupsBrowserJobId}/backups`)
    .then(data => {
      currentBackupsData = { psql: data.psql || [], minio: data.minio || [] };
      renderBackupsBrowserList(backupsBrowserJobId, data);
    })
    .catch(err => {
      if (listEl) {
        listEl.innerHTML = `
          <p style="color: var(--error); padding: 20px;">Refresh failed: ${escapeHtml(err.message)}</p>
          <button class="btn btn-sm js-open-backups" data-job-id="${backupsBrowserJobId}">Retry</button>
        `;
      }
    });
}

function onBackupsBrowserSearch(value) {
  backupsSearchTerm = value || '';
  if (backupsBrowserJobId) {
    renderBackupsBrowserList(backupsBrowserJobId, currentBackupsData);
  }
}

function renderBackupsBrowserList(jobId, data) {
  const listContainer = document.getElementById('backups-browser-list');
  const countEl = document.getElementById('backups-browser-count');
  if (!listContainer) return;

  const term = (backupsSearchTerm || '').toLowerCase().trim();
  let psql = (data && data.psql) || [];
  let minio = (data && data.minio) || [];

  if (term) {
    psql = psql.filter(b => b.name.toLowerCase().includes(term));
    minio = minio.filter(b => b.name.toLowerCase().includes(term));
  }

  const total = psql.length + minio.length;
  if (countEl) {
    countEl.textContent = `${total} backup${total === 1 ? '' : 's'}`;
  }

  if (total === 0) {
    const scope = data && data.psql_prefix ? ` for ${escapeHtml(data.psql_prefix)}` : '';
    const msg = term
      ? 'No matching backups.'
      : `No backups found${scope} on RAID for this job.<br>Run the job with the "persist" step.`;
    listContainer.innerHTML = `<div class="backups-empty" style="padding:24px;">${msg}</div>`;
    return;
  }

  let html = '<div class="backups-list">';

  const scopeLabel = data && data.psql_prefix ? ` · ${escapeHtml(data.psql_prefix)}` : '';

  if (psql.length > 0) {
    html += `<div class="backups-group-label">PostgreSQL${scopeLabel}</div>`;
    const groups = groupBackups(psql);
    for (const g of groups) {
      html += `<div class="backup-group"><div class="backup-group-head">${g.label}</div>`;
      html += g.items.map(b => renderBackupRow(jobId, b)).join('');
      html += `</div>`;
    }
  }

  if (minio.length > 0) {
    html += `<div class="backups-group-label" style="margin-top:10px;">MinIO</div>`;
    const groups = groupBackups(minio);
    for (const g of groups) {
      html += `<div class="backup-group"><div class="backup-group-head">${g.label}</div>`;
      html += g.items.map(b => renderBackupRow(jobId, b)).join('');
      html += `</div>`;
    }
  }

  html += '</div>';

  listContainer.innerHTML = html;
  // Note: actual click handling is done via event delegation on #backups-browser-list (set up in DOMContentLoaded)
}

// Job CRUD
async function openNewJobModal() {
  currentJobId = null;
  document.getElementById('modal-title').textContent = 'New Job';
  document.getElementById('job-form').reset();
  document.getElementById('job-id').value = '';
  document.getElementById('job-type').value = 'psql';

  // Reset steps to all checked
  setStepsCheckboxes(ALL_STEPS);

  await populateSshEndpointDropdown(null);

  // Add default env vars
  const container = document.getElementById('env-vars-container');
  container.replaceChildren();

  const defaultVars = [
    'RAID_PATH',
    'ENVIRONMENT',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_DB',
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

    // Job type select only has 'psql' now; legacy values stay in DB but the select can't represent them.
    const jobTypeSelect = document.getElementById('job-type');
    if ([...jobTypeSelect.options].some(o => o.value === job.job_type)) {
      jobTypeSelect.value = job.job_type;
    } else {
      jobTypeSelect.value = 'psql';
    }

    await populateSshEndpointDropdown(job.ssh_endpoint_id);

    // Set steps checkboxes
    setStepsCheckboxes(job.steps || ALL_STEPS);

    const container = document.getElementById('env-vars-container');
    container.replaceChildren();

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

  const sshEndpointVal = document.getElementById('job-ssh-endpoint').value;

  const data = {
    name: name,
    description: document.getElementById('job-description').value.trim(),
    job_type: document.getElementById('job-type').value,
    steps: steps,
    env_vars: envVars,
    ssh_endpoint_id: sshEndpointVal ? parseInt(sshEndpointVal, 10) : null,
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
  // Close any open modals first (don't disturb the main nav)
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));

  // Push a proper history entry so browser back/forward works
  const url = new URL(window.location);
  url.searchParams.set('tab', activeTab);
  url.searchParams.set('run', runId);
  history.pushState(null, '', url);

  // Find nice labels for the breadcrumb (best effort; sync will also load the run)
  const run = allRuns.find(r => r.id === runId);
  const parentLabel = activeTab === 'jobs' ? 'Jobs' : 'Activity';
  const currentLabel = run ? `Run #${run.id} - ${run.job_name}` : `Run #${runId}`;

  // Immediately show the chrome + labels (syncRoute would also do this after popstate)
  showBreadcrumb(parentLabel, currentLabel);
  showLogViewerChrome();

  currentRunId = runId;
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

  // Remove the run from URL and push so history is correct
  const url = new URL(window.location);
  url.searchParams.delete('run');
  history.pushState(null, '', url);

  // Let the route sync handle hiding the viewer and restoring the tab content
  syncRouteFromURL();
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

    // Keep the breadcrumb in sync too (useful for deep links / history restore)
    const parentLabel = activeTab === 'jobs' ? 'Jobs' : 'Activity';
    showBreadcrumb(parentLabel, `Run #${run.id} - ${run.job_name}`);

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

// SSH Endpoints
async function populateSshEndpointDropdown(selectedId) {
  const select = document.getElementById('job-ssh-endpoint');

  // Always refresh from the API so we don't render a stale list when the modal
  // is opened before the initial loadData() resolves, or after the user adds an
  // endpoint in another tab.
  try {
    sshEndpoints = await api('/ssh-endpoints');
  } catch (err) {
    console.error('Failed to refresh SSH endpoints:', err);
  }

  select.replaceChildren();

  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'None (direct connection)';
  select.appendChild(noneOpt);

  for (const ep of sshEndpoints) {
    const opt = document.createElement('option');
    opt.value = String(ep.id);
    opt.textContent = ep.name;
    if (selectedId && Number(selectedId) === ep.id) {
      opt.selected = true;
    }
    select.appendChild(opt);
  }
}

function renderSshEndpointsTable() {
  const tbody = document.getElementById('ssh-endpoints-tbody');
  if (!tbody) return;
  tbody.replaceChildren();

  if (sshEndpoints.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const h = document.createElement('h3');
    h.textContent = 'No SSH endpoints configured';
    const p = document.createElement('p');
    p.textContent = 'Add an endpoint to tunnel jobs through a bastion host.';
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = '+ New Endpoint';
    btn.addEventListener('click', openNewEndpointModal);
    empty.appendChild(h);
    empty.appendChild(p);
    empty.appendChild(btn);
    td.appendChild(empty);
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const ep of sshEndpoints) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'job-name';
    nameSpan.textContent = ep.name;
    tdName.appendChild(nameSpan);
    if (ep.description) {
      const desc = document.createElement('div');
      desc.className = 'schedule-desc';
      desc.textContent = ep.description;
      tdName.appendChild(desc);
    }
    tr.appendChild(tdName);

    const tdHost = document.createElement('td');
    tdHost.textContent = `${ep.host}:${ep.port}`;
    tr.appendChild(tdHost);

    const tdUser = document.createElement('td');
    tdUser.textContent = ep.username;
    tr.appendChild(tdUser);

    const tdTest = document.createElement('td');
    const stack = document.createElement('div');
    stack.style.display = 'flex';
    stack.style.flexDirection = 'column';
    stack.style.alignItems = 'flex-start';
    stack.style.gap = '4px';
    const status = ep.last_test_status || 'untested';
    const badge = document.createElement('span');
    badge.className = `status-badge-inline status-${status === 'ok' ? 'success' : status === 'fail' ? 'failed' : 'pending'}`;
    badge.textContent = status === 'ok' ? '✓ ok' : status === 'fail' ? '✗ failed' : '— untested';
    stack.appendChild(badge);
    if (ep.last_tested_at) {
      const time = document.createElement('span');
      time.style.fontSize = '0.8125rem';
      time.style.color = 'var(--text-muted)';
      time.textContent = formatRelativeTime(ep.last_tested_at);
      stack.appendChild(time);
    }
    tdTest.appendChild(stack);
    tr.appendChild(tdTest);

    const tdActions = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'job-actions';

    const testBtn = document.createElement('button');
    testBtn.className = 'btn btn-sm';
    testBtn.textContent = 'Test';
    testBtn.addEventListener('click', () => testEndpoint(ep.id));
    actions.appendChild(testBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => editEndpoint(ep.id));
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteEndpoint(ep.id));
    actions.appendChild(delBtn);

    tdActions.appendChild(actions);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }
}

function openNewEndpointModal() {
  currentEndpointId = null;
  document.getElementById('endpoint-modal-title').textContent = 'New SSH Endpoint';
  document.getElementById('endpoint-form').reset();
  document.getElementById('endpoint-id').value = '';
  document.getElementById('endpoint-port').value = '22';
  document.getElementById('endpoint-private-key').placeholder = '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----';
  document.getElementById('endpoint-key-hint').textContent = 'Paste the full private key including BEGIN/END lines.';
  document.getElementById('endpoint-passphrase').value = '';
  document.getElementById('endpoint-passphrase').placeholder = 'Leave blank if the key is unencrypted';
  document.getElementById('endpoint-passphrase-hint').textContent = 'Required only if your private key is passphrase-protected. Stored encrypted with the master key.';
  document.getElementById('endpoint-clear-passphrase-group').style.display = 'none';
  document.getElementById('endpoint-clear-passphrase').checked = false;
  document.getElementById('endpoint-test-result').textContent = '';
  document.getElementById('btn-test-endpoint').style.display = 'none';
  document.getElementById('btn-show-public-key').style.display = 'none';
  document.getElementById('endpoint-public-key-block').style.display = 'none';
  document.getElementById('endpoint-public-key-content').textContent = '';
  document.getElementById('endpoint-modal').classList.remove('hidden');
}

async function editEndpoint(endpointId) {
  try {
    const ep = await api(`/ssh-endpoints/${endpointId}`);
    currentEndpointId = endpointId;
    document.getElementById('endpoint-modal-title').textContent = 'Edit SSH Endpoint';
    document.getElementById('endpoint-id').value = ep.id;
    document.getElementById('endpoint-name').value = ep.name;
    document.getElementById('endpoint-description').value = ep.description || '';
    document.getElementById('endpoint-host').value = ep.host;
    document.getElementById('endpoint-port').value = ep.port;
    document.getElementById('endpoint-username').value = ep.username;
    document.getElementById('endpoint-private-key').value = '';
    document.getElementById('endpoint-private-key').placeholder = 'Leave blank to keep existing key';
    document.getElementById('endpoint-key-hint').textContent = 'Leave blank to keep existing key. Replacing the key will invalidate the saved host fingerprint — re-test after saving.';
    document.getElementById('endpoint-passphrase').value = '';
    document.getElementById('endpoint-passphrase').placeholder = ep.has_passphrase
      ? 'Leave blank to keep existing passphrase'
      : 'Leave blank if the key is unencrypted';
    document.getElementById('endpoint-passphrase-hint').textContent = ep.has_passphrase
      ? 'A passphrase is currently saved. Leave blank to keep it, type a new one to replace, or check the box below to remove it.'
      : 'Required only if your private key is passphrase-protected. Stored encrypted with the master key.';
    document.getElementById('endpoint-clear-passphrase-group').style.display = ep.has_passphrase ? 'block' : 'none';
    document.getElementById('endpoint-clear-passphrase').checked = false;
    document.getElementById('endpoint-test-result').textContent = '';
    document.getElementById('btn-test-endpoint').style.display = 'inline-flex';
    document.getElementById('btn-show-public-key').style.display = 'inline-flex';
    document.getElementById('endpoint-public-key-block').style.display = 'none';
    document.getElementById('endpoint-public-key-content').textContent = '';
    document.getElementById('endpoint-modal').classList.remove('hidden');
  } catch (err) {
    alert('Error loading endpoint: ' + err.message);
  }
}

async function showPublicKey() {
  if (!currentEndpointId) return;
  const block = document.getElementById('endpoint-public-key-block');
  const content = document.getElementById('endpoint-public-key-content');
  content.textContent = 'Deriving...';
  block.style.display = 'block';
  try {
    const result = await api(`/ssh-endpoints/${currentEndpointId}/public-key`);
    content.textContent = result.authorized_keys_line || result.public_key;
  } catch (err) {
    content.textContent = 'Failed: ' + err.message;
  }
}

function copyPublicKey() {
  const content = document.getElementById('endpoint-public-key-content').textContent;
  if (!content) return;
  const btn = document.querySelector('[onclick="copyPublicKey()"]');
  const original = btn ? btn.textContent : '';
  const flash = () => {
    if (btn) {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(content).then(flash).catch(() => fallback());
  } else {
    fallback();
  }
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = content;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    flash();
  }
}

async function saveEndpoint(e) {
  e.preventDefault();

  const passphrase = document.getElementById('endpoint-passphrase').value;
  const clearPassphrase = document.getElementById('endpoint-clear-passphrase').checked;

  const data = {
    name: document.getElementById('endpoint-name').value.trim(),
    description: document.getElementById('endpoint-description').value.trim(),
    host: document.getElementById('endpoint-host').value.trim(),
    port: parseInt(document.getElementById('endpoint-port').value, 10),
    username: document.getElementById('endpoint-username').value.trim(),
    private_key: document.getElementById('endpoint-private-key').value,
    passphrase,
    clear_passphrase: clearPassphrase,
  };

  if (!data.name || !data.host || !data.username) {
    alert('Name, host, and username are required');
    return;
  }
  if (!currentEndpointId && !data.private_key.trim()) {
    alert('Private key is required for new endpoints');
    return;
  }
  if (clearPassphrase && passphrase.length > 0) {
    alert("Either type a new passphrase or check 'Remove existing passphrase' — not both.");
    return;
  }

  try {
    if (currentEndpointId) {
      // PUT — only send key/passphrase if provided
      const payload = { ...data };
      if (!payload.private_key.trim()) delete payload.private_key;
      if (!payload.clear_passphrase && payload.passphrase.length === 0) delete payload.passphrase;
      if (!payload.clear_passphrase) delete payload.clear_passphrase;
      await api(`/ssh-endpoints/${currentEndpointId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      const payload = { ...data };
      delete payload.clear_passphrase;
      if (payload.passphrase.length === 0) delete payload.passphrase;
      await api('/ssh-endpoints', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    closeEndpointModal();
    loadData();
  } catch (err) {
    alert('Error saving endpoint: ' + err.message);
  }
}

async function deleteEndpoint(endpointId) {
  if (!confirm('Delete this SSH endpoint? Jobs referencing it will lose the tunnel and need to be reconfigured.')) return;
  try {
    await api(`/ssh-endpoints/${endpointId}`, { method: 'DELETE' });
    loadData();
  } catch (err) {
    alert('Error deleting endpoint: ' + err.message);
  }
}

// Extract a short fingerprint summary from the captured known_hosts file content.
// Returns something like 'ecdsa-sha2-nistp256 AAAAE2VjZHNh...' truncated for display.
function summarizeKnownHosts(knownHosts) {
  if (!knownHosts) return '';
  const line = knownHosts.split('\n').find(l => l.trim() && !l.startsWith('#'));
  if (!line) return '';
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) return line.trim().slice(0, 80);
  const [, type, key] = parts;
  return `${type} ${key.slice(0, 24)}…${key.slice(-8)}`;
}

async function testEndpoint(endpointId) {
  try {
    const result = await api(`/ssh-endpoints/${endpointId}/test`, { method: 'POST' });
    if (result.status === 'ok') {
      const fp = summarizeKnownHosts(result.known_hosts);
      alert('✓ Connection successful.\n\nCaptured host key:\n' + (fp || '(none)') + '\n\nVerify this matches the bastion you intended to reach before running tunneled jobs against it.');
    } else {
      alert('✗ Connection failed:\n\n' + (result.error || 'Unknown error'));
    }
    loadData();
  } catch (err) {
    alert('Error testing endpoint: ' + err.message);
  }
}

async function testEndpointFromModal() {
  if (!currentEndpointId) return;
  const resultDiv = document.getElementById('endpoint-test-result');
  resultDiv.textContent = 'Testing...';
  resultDiv.style.color = '';
  try {
    const result = await api(`/ssh-endpoints/${currentEndpointId}/test`, { method: 'POST' });
    if (result.status === 'ok') {
      const fp = summarizeKnownHosts(result.known_hosts);
      resultDiv.textContent = `✓ Connection successful. Host key: ${fp || '(none)'} — verify this matches the bastion before relying on it.`;
      resultDiv.style.color = 'var(--success)';
    } else {
      resultDiv.textContent = '✗ ' + (result.error || 'Connection failed');
      resultDiv.style.color = 'var(--error)';
    }
  } catch (err) {
    resultDiv.textContent = '✗ ' + err.message;
    resultDiv.style.color = 'var(--error)';
  }
}

function closeEndpointModal() {
  document.getElementById('endpoint-modal').classList.add('hidden');
  currentEndpointId = null;
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

function formatBytes(bytes) {
  if (bytes == null || bytes === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return val.toFixed(val < 10 && i > 0 ? 1 : 0) + ' ' + units[i];
}

function parseBackupTime(name) {
  if (!name) return '';
  // PSQL: dbname_20260110_151532
  let m = name.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  }
  // MinIO: bucket_2026_0110_151530.tar.gz
  m = name.match(/_(\d{4})_(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.tar\.gz$/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  }
  return '';
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
