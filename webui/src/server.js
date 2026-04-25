const express = require('express');
const path = require('path');

const jobsRouter = require('./routes/jobs');
const runsRouter = require('./routes/runs');
const schedulesRouter = require('./routes/schedules');
const sshEndpointsRouter = require('./routes/ssh-endpoints');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// API routes
app.use('/api/jobs', jobsRouter);
app.use('/api', runsRouter);  // Mounts /jobs/:id/run and /runs/* routes
app.use('/api', schedulesRouter);
app.use('/api/ssh-endpoints', sshEndpointsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve index.html for all other routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`BackDatUp Web UI running on http://localhost:${PORT}`);

  // Load scheduled jobs
  scheduler.loadSchedules();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  process.exit(0);
});
