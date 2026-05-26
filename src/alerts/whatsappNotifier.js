'use strict';

// Prepared for a future WhatsApp Cloud API integration. Notification Engine v1
// does not activate this provider.
function isConfigured() {
  return !!process.env.WHATSAPP_TOKEN &&
    !!process.env.WHATSAPP_PHONE_NUMBER_ID &&
    !!process.env.WHATSAPP_TARGET_PHONE;
}

async function send() {
  return { ok: false, skipped: true, reason: 'whatsapp_not_enabled' };
}

module.exports = { isConfigured, send };
