import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TESTS_DIR, '..');

process.env.RESUME_JOBS_OFFLINE_GUARD_ACTIVE = '1';

function guardedError(code, operation) {
  const error = new Error(`Offline test guard blocked ${operation}`);
  error.code = code;
  return error;
}

function pathFrom(value) {
  if (value instanceof URL) {
    if (value.protocol !== 'file:') return null;
    return fileURLToPath(value);
  }
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    return path.resolve(String(value));
  }
  return null;
}

function isProjectPath(value) {
  const resolved = pathFrom(value);
  return Boolean(
    resolved &&
    (resolved === PROJECT_ROOT || resolved.startsWith(`${PROJECT_ROOT}${path.sep}`))
  );
}

function assertProjectWriteBlocked(operation, values) {
  if (values.some(isProjectPath)) {
    throw guardedError('OFFLINE_TEST_WRITE_BLOCKED', `${operation} inside the project`);
  }
}

function guardPathMethod(target, name, pathIndexes = [0]) {
  const original = target[name];
  if (typeof original !== 'function') return;
  target[name] = function guardedPathMethod(...args) {
    assertProjectWriteBlocked(name, pathIndexes.map((index) => args[index]));
    return Reflect.apply(original, this, args);
  };
}

function guardAsyncPathMethod(target, name, pathIndexes = [0]) {
  const original = target[name];
  if (typeof original !== 'function') return;
  target[name] = async function guardedAsyncPathMethod(...args) {
    assertProjectWriteBlocked(name, pathIndexes.map((index) => args[index]));
    return Reflect.apply(original, this, args);
  };
}

for (const method of [
  'appendFile',
  'appendFileSync',
  'chmod',
  'chmodSync',
  'chown',
  'chownSync',
  'createWriteStream',
  'lchmod',
  'lchmodSync',
  'lchown',
  'lchownSync',
  'lutimes',
  'lutimesSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'truncate',
  'truncateSync',
  'unlink',
  'unlinkSync',
  'utimes',
  'utimesSync',
  'writeFile',
  'writeFileSync'
]) {
  guardPathMethod(fs, method);
}

for (const method of ['copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync', 'symlink', 'symlinkSync']) {
  guardPathMethod(fs, method, [1]);
}
for (const method of ['rename', 'renameSync']) {
  guardPathMethod(fs, method, [0, 1]);
}

for (const method of [
  'appendFile',
  'chmod',
  'chown',
  'cp',
  'lchmod',
  'lchown',
  'lutimes',
  'mkdir',
  'mkdtemp',
  'rm',
  'rmdir',
  'truncate',
  'unlink',
  'utimes',
  'writeFile'
]) {
  guardAsyncPathMethod(fsPromises, method);
}
for (const method of ['copyFile', 'link', 'symlink']) {
  guardAsyncPathMethod(fsPromises, method, [1]);
}
guardAsyncPathMethod(fsPromises, 'rename', [0, 1]);

function blockOpen(target, name) {
  const original = target[name];
  if (typeof original !== 'function') return;
  target[name] = function guardedOpen(file, flags, ...rest) {
    const writes = typeof flags === 'number'
      ? (flags & fs.constants.O_WRONLY) !== 0 || (flags & fs.constants.O_RDWR) !== 0
      : /[wa+]/.test(String(flags || 'r'));
    if (writes) assertProjectWriteBlocked(name, [file]);
    return Reflect.apply(original, this, [file, flags, ...rest]);
  };
}

blockOpen(fs, 'open');
blockOpen(fs, 'openSync');

const originalPromiseOpen = fsPromises.open;
fsPromises.open = async function guardedPromiseOpen(file, flags, ...rest) {
  const writes = typeof flags === 'number'
    ? (flags & fs.constants.O_WRONLY) !== 0 || (flags & fs.constants.O_RDWR) !== 0
    : /[wa+]/.test(String(flags || 'r'));
  if (writes) assertProjectWriteBlocked('open', [file]);
  return Reflect.apply(originalPromiseOpen, this, [file, flags, ...rest]);
};

function blockedNetwork(operation) {
  throw guardedError('OFFLINE_TEST_NETWORK_BLOCKED', operation);
}

http.request = () => blockedNetwork('http.request');
http.get = () => blockedNetwork('http.get');
https.request = () => blockedNetwork('https.request');
https.get = () => blockedNetwork('https.get');
net.connect = () => blockedNetwork('net.connect');
net.createConnection = () => blockedNetwork('net.createConnection');
tls.connect = () => blockedNetwork('tls.connect');
dgram.createSocket = () => blockedNetwork('dgram.createSocket');

globalThis.fetch = async () => {
  throw guardedError('OFFLINE_TEST_NETWORK_BLOCKED', 'fetch');
};

if (typeof globalThis.WebSocket === 'function') {
  globalThis.WebSocket = class OfflineTestWebSocket {
    constructor() {
      throw guardedError('OFFLINE_TEST_NETWORK_BLOCKED', 'WebSocket');
    }
  };
}

syncBuiltinESMExports();
