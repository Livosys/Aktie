'use strict';

const axios = require('axios');
const { SYSTEM_PROMPT } = require('./systemPrompt');

const RISK_NOTE = 'Detta är inte finansiell rådgivning.';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1/chat/completions';

function isConfigured() {
  return !!process.env.AI_API_KEY;
}

function buildUserPrompt({ question, page, symbol, context }) {
  return [
    `Fråga: ${question}`,
    `Sida: ${page || 'live'}`,
    `Vald symbol: ${symbol || 'ingen'}`,
    '',
    'Read-only kontext från appen:',
    JSON.stringify(context, null, 2),
    '',
    'Svara på enkel svenska. Avsluta med en kort risknotis.',
  ].join('\n');
}

function normalizeAnswer(answer) {
  const text = String(answer || '').trim();
  if (!text) return `Jag kunde inte skapa ett tydligt svar. ${RISK_NOTE}`;
  if (text.toLowerCase().includes('inte finansiell rådgivning')) return text;
  return `${text}\n\n${RISK_NOTE}`;
}

async function askAi({ question, page, symbol, context }) {
  if (!isConfigured()) {
    const err = new Error('AI is not configured');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }

  const timeoutMs = Math.min(parseInt(process.env.AI_TIMEOUT_MS || '15000', 10), 30000);
  const url = process.env.AI_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.AI_MODEL || DEFAULT_MODEL;

  const response = await axios.post(url, {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt({ question, page, symbol, context }) },
    ],
    temperature: 0.2,
    max_tokens: 700,
  }, {
    timeout: timeoutMs,
    headers: {
      Authorization: `Bearer ${process.env.AI_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const answer = response.data?.choices?.[0]?.message?.content;
  return normalizeAnswer(answer);
}

module.exports = {
  RISK_NOTE,
  askAi,
  isConfigured,
};
