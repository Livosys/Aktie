'use strict';

const model = require('./pineResearchModelService');

const FORBIDDEN_PATTERNS = Object.freeze([
  { pattern: /lookahead_on/i, code: 'lookahead_on_is_not_allowed' },
  { pattern: /request\.security\s*\([^)]*lookahead\s*=/is, code: 'request_security_lookahead_is_not_allowed' },
  { pattern: /strategy\.order\s*\(/i, code: 'strategy_order_is_not_allowed' },
  { pattern: /alert\s*\(/i, code: 'tradingview_alerts_are_not_allowed_in_research_export' },
  { pattern: /webhook/i, code: 'webhook_forwarding_is_not_allowed' },
  { pattern: /broker/i, code: 'broker_reference_is_not_allowed' },
  { pattern: /placeorder|submitorder|place\s+order|submit\s+order/i, code: 'order_routing_is_not_allowed' },
]);

function balancedDelimiters(source) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let inString = false;
  let quote = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const prev = source[i - 1];
    if ((ch === '"' || ch === "'") && prev !== '\\') {
      if (!inString) {
        inString = true;
        quote = ch;
      } else if (quote === ch) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (inString) continue;
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return stack.length === 0 && !inString;
}

function hasConstSafeInputTime(source) {
  const matches = source.match(/input\.time\s*\(([^)]*\)[^)]*)\)/gis) || [];
  if (!matches.length) return false;
  return matches.every((entry) => /timestamp\s*\(\s*"[^"]+"\s*\)/i.test(entry)
    && !/timestamp\s*\(\s*"America\/[^"]+"\s*,\s*\d{4}/i.test(entry));
}

function validatePineSource(input = {}) {
  const sourceCode = String(input.sourceCode || input.source || '');
  const errors = [];
  const warnings = [];

  if (!sourceCode.trim()) errors.push('source_code_is_required');
  if (!/^\s*\/\/@version=6/m.test(sourceCode)) errors.push('pine_version_6_is_required');
  if (!/strategy\s*\(/i.test(sourceCode)) errors.push('strategy_call_is_required');
  if (!/strategyId\s*:/i.test(sourceCode)) errors.push('strategy_id_metadata_is_required');
  if (!/candidateId\s*:/i.test(sourceCode)) errors.push('candidate_id_metadata_is_required');
  if (!/pineVersionId\s*:/i.test(sourceCode)) errors.push('pine_version_id_metadata_is_required');
  if (!/timezone\s*:/i.test(sourceCode) && !/timezone\s*=/i.test(sourceCode)) errors.push('timezone_metadata_is_required');
  if (!/input\.session\s*\(/i.test(sourceCode)) errors.push('session_input_is_required');
  if (!balancedDelimiters(sourceCode)) errors.push('unbalanced_delimiters');
  if (!hasConstSafeInputTime(sourceCode)) errors.push('input_time_must_use_const_safe_timestamp_string');

  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(sourceCode)) errors.push(rule.code);
  }

  const entries = sourceCode.match(/strategy\.entry\s*\([^)]*\)/gis) || [];
  if (!entries.length) errors.push('strategy_entry_is_required');
  if (entries.some((entry) => !/strategy\.(long|short)/i.test(entry))) errors.push('strategy_entry_direction_is_required');
  if (!/strategy\.exit\s*\([^)]*stop\s*=[^)]*limit\s*=/is.test(sourceCode)) errors.push('stop_and_target_exit_is_required');
  if (!/strategy\.close_all\s*\(/i.test(sourceCode)) errors.push('forced_close_is_required_for_intraday_research');
  if (!/allowLong\s*=/i.test(sourceCode) || !/allowShort\s*=/i.test(sourceCode)) errors.push('direction_flags_are_required');

  const expectedHash = String(input.sourceHash || '').trim();
  if (expectedHash && expectedHash !== model.hashText(sourceCode)) errors.push('source_hash_mismatch');

  if (!/request\.security\s*\(/i.test(sourceCode)) {
    warnings.push('no_external_security_calls_detected');
  }
  warnings.push('static_validation_only_external_tradingview_compile_required');

  const compileStatus = errors.length ? 'static_invalid' : 'static_valid';
  return model.withSafety({
    ok: errors.length === 0,
    compileStatus,
    compileErrors: errors,
    validationWarnings: warnings,
    sourceHash: model.hashText(sourceCode),
  });
}

function validatePineVersion(version) {
  const normalized = model.normalizeVersion(version);
  const result = validatePineSource(normalized);
  return model.normalizeVersion({
    ...normalized,
    sourceHash: result.sourceHash,
    compileStatus: result.compileStatus,
    compileErrors: result.compileErrors,
    validationWarnings: result.validationWarnings,
    status: result.ok ? 'ready_for_test' : 'invalid',
  });
}

module.exports = {
  validatePineSource,
  validatePineVersion,
};
