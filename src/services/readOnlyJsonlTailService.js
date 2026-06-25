'use strict';

const fs = require('fs');

function clampPositiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.round(n)));
}

function readJsonlTail(file, options = {}) {
  const maxBytes = clampPositiveInt(options.maxBytes, 8 * 1024 * 1024, 64 * 1024 * 1024);
  const maxLines = clampPositiveInt(options.maxLines, 25_000, 500_000);
  const rows = [];
  const warnings = [];
  let size = 0;
  let partial = false;
  let exists = false;

  try {
    const stat = fs.statSync(file);
    exists = true;
    size = stat.size;
    partial = size > maxBytes;
    const start = partial ? Math.max(0, size - maxBytes) : 0;
    const fd = fs.openSync(file, 'r');
    try {
      const length = size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      let text = buffer.toString('utf8');
      if (partial) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
        warnings.push(`jsonl_tail_limited:${file}`);
      }
      const lines = text.split('\n').filter((line) => line.trim());
      const tailLines = lines.slice(-maxLines);
      if (lines.length > tailLines.length) warnings.push(`jsonl_line_limited:${file}`);
      for (const line of tailLines) {
        if (line.charCodeAt(0) !== 123) continue;
        try { rows.push(JSON.parse(line)); }
        catch (_) { warnings.push(`jsonl_parse_skipped:${file}`); }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { rows, exists: false, size: 0, partial: false, warnings: [`jsonl_missing:${file}`] };
    return { rows, exists, size, partial: true, warnings: [`jsonl_read_failed:${file}`] };
  }

  return { rows, exists, size, partial, warnings };
}

module.exports = {
  readJsonlTail,
};
