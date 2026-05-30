'use strict';

// LLM adapter stub — default disabled. Set LLM_ENABLED=true + configure provider to activate.
// When disabled, the system intelligence agent falls back to rule_based_v1 analysis.

const LLM_ENABLED = process.env.LLM_ENABLED === 'true';
const PROVIDER = process.env.LLM_PROVIDER || 'none';

function isEnabled() { return LLM_ENABLED; }
function provider() { return LLM_ENABLED ? PROVIDER : 'none'; }

// Future: call OpenAI/Claude here and return structured analysis
async function analyze(/* question, context */) {
  return { ok: false, error: 'llm_not_enabled', mode: 'rule_based_v1' };
}

module.exports = { isEnabled, provider, analyze };
