#!/usr/bin/env node
// Emergency Factory Recovery - Marks stuck jobs as failed
const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join(__dirname, 'data/replay-queue/events.jsonl');

function recoverStuckJobs() {
  const lines = fs.readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(Boolean);
  const now = new Date().toISOString();
  const recovered = [];

  const events = lines.map(line => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter(Boolean);

  // Find jobs RUNNING for > 1 hour
  const runningJobs = {};
  events.forEach(e => {
    if (e.event_type === 'JOB_STARTED') {
      const jobId = e.job_id;
      const startedAt = new Date(e.created_at || e.started_at);
      const age = Date.now() - startedAt.getTime();
      if (age > 60 * 60 * 1000) {
        if (!runningJobs[jobId] || runningJobs[jobId].age < age) {
          runningJobs[jobId] = { startedAt: e.created_at, age };
        }
      }
    }
    if (e.event_type === 'JOB_COMPLETED' || e.event_type === 'JOB_FAILED') {
      delete runningJobs[e.job_id];
    }
  });

  // Append recovery events
  Object.entries(runningJobs).forEach(([jobId, info]) => {
    const recovery = {
      event_id: `recovery_${jobId}_${Date.now()}`,
      created_at: now,
      event_type: 'JOB_FAILED',
      job_id: jobId,
      failed_at: now,
      error: 'stale_job_exceeded_safe_runtime_automatic_recovery',
      recovery_reason: `Job stale > 1hr - auto-recovery`,
      safety: {
        mode: 'paper_only',
        paper_only: true,
        actions_allowed: false,
        can_place_orders: false,
        live_trading_enabled: false,
        broker_enabled: false
      }
    };
    fs.appendFileSync(QUEUE_FILE, JSON.stringify(recovery) + '\n');
    recovered.push(jobId);
  });

  return recovered;
}

const recovered = recoverStuckJobs();
console.log('Recovered:', recovered);
