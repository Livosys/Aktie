'use strict';

const axios = require('axios');

function isConfigured() {
  return !!process.env.SIGNAL_WEBHOOK_URL;
}

async function send(message, payload = {}) {
  if (!isConfigured()) {
    console.log('[Notifier] disabled or not configured');
    return { ok: false, skipped: true, reason: 'not_configured' };
  }

  await axios.post(process.env.SIGNAL_WEBHOOK_URL, {
    text: message,
    ...payload,
  }, { timeout: 10000 });

  return { ok: true, provider: 'webhook' };
}

module.exports = { isConfigured, send };
