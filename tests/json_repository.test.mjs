import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJsonFile, writeJsonAtomic } from '../scripts/lib/json_repository.mjs';

test('atomic JSON repository creates and replaces complete documents without temp residue', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-json-repository-'));
  const file = path.join(root, 'nested', 'state.json');
  try {
    writeJsonAtomic(file, { version: 1, items: ['first'] });
    assert.deepEqual(readJsonFile(file), { version: 1, items: ['first'] });
    writeJsonAtomic(file, { version: 2, items: ['replacement'] });
    assert.deepEqual(readJsonFile(file), { version: 2, items: ['replacement'] });
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('serialization failure leaves the previous JSON document intact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-json-failure-'));
  const file = path.join(root, 'state.json');
  try {
    writeJsonAtomic(file, { stable: true });
    const circular = {}; circular.self = circular;
    assert.throws(() => writeJsonAtomic(file, circular));
    assert.deepEqual(readJsonFile(file), { stable: true });
    assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
