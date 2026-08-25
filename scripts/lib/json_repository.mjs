import fs from 'node:fs';
import path from 'node:path';

export function readJsonFile(filePath, fallback) {
  const hasFallback = arguments.length >= 2;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) {
    if (hasFallback && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function writeJsonAtomic(filePath, value, { mode = 0o600 } = {}) {
  const destination = path.resolve(filePath);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(descriptor, payload, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    try { fs.chmodSync(destination, mode); }
    catch {
      // Windows filesystems may not support POSIX modes; the atomic write has
      // already completed and remains valid.
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); }
      catch {
        // Preserve the original write failure.
      }
    }
    try { fs.unlinkSync(temporary); }
    catch {
      // Preserve the original write failure; stale temporary files remain
      // distinguishable and are never treated as the repository document.
    }
    throw error;
  }
  return destination;
}
