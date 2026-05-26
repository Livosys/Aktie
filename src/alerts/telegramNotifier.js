'use strict';

const axios = require('axios');

function isConfigured() {
  return !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;
}

async function send(message) {
  if (!isConfigured()) {
    console.log('[Notifier] disabled or not configured');
    return { ok: false, skipped: true, reason: 'not_configured' };
  }

  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: message,
    disable_web_page_preview: true,
  }, { timeout: 10000 });

  return { ok: true, provider: 'telegram' };
}

module.exports = { isConfigured, send };
