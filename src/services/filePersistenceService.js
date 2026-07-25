'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function ensureParentDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function fsyncDirBestEffort(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (_) {
    // Directory fsync is not supported on every filesystem; file fsync + rename
    // still prevents partial target-file writes on the production Linux path.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function writeFileAtomic(file, data, encoding = 'utf8') {
  ensureParentDir(file);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data, encoding);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    fsyncDirBestEffort(dir);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

function writeJsonAtomic(file, value, options = {}) {
  const trailingNewline = options.trailingNewline !== false;
  const payload = `${JSON.stringify(value, null, 2)}${trailingNewline ? '\n' : ''}`;
  writeFileAtomic(file, payload, 'utf8');
  return value;
}

module.exports = {
  writeFileAtomic,
  writeJsonAtomic,
};
