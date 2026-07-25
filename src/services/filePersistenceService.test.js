'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeFileAtomic, writeJsonAtomic } = require('./filePersistenceService');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-persistence-'));

try {
  const jsonFile = path.join(tmpDir, 'state.json');
  const payload = { ok: true, nested: { value: 7 } };
  const returned = writeJsonAtomic(jsonFile, payload, { trailingNewline: false });
  assert.deepEqual(returned, payload);
  assert.equal(fs.readFileSync(jsonFile, 'utf8'), JSON.stringify(payload, null, 2));
  assert.deepEqual(JSON.parse(fs.readFileSync(jsonFile, 'utf8')), payload);

  const newlineFile = path.join(tmpDir, 'with-newline.json');
  writeJsonAtomic(newlineFile, { ok: true });
  assert.equal(fs.readFileSync(newlineFile, 'utf8').endsWith('\n'), true);

  const textFile = path.join(tmpDir, 'events.jsonl');
  writeFileAtomic(textFile, '{"a":1}\n', 'utf8');
  writeFileAtomic(textFile, '{"a":2}\n', 'utf8');
  assert.equal(fs.readFileSync(textFile, 'utf8'), '{"a":2}\n');

  const originalRenameSync = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('forced rename failure');
  };
  try {
    assert.throws(
      () => writeFileAtomic(path.join(tmpDir, 'failure.json'), '{"ok":false}\n', 'utf8'),
      /forced rename failure/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(fs.existsSync(path.join(tmpDir, 'failure.json')), false);
  assert.deepEqual(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.tmp')), []);

  console.log('filePersistenceService.test.js passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
