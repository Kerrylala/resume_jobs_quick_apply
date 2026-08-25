import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function directoryFromMetaUrl(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}

export function projectRootFromMetaUrl(metaUrl, levelsUp = 1) {
  if (!Number.isInteger(levelsUp) || levelsUp < 0) {
    throw new TypeError('levelsUp must be a non-negative integer');
  }
  return path.resolve(directoryFromMetaUrl(metaUrl), ...Array(levelsUp).fill('..'));
}

export function isMainModule(metaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  return metaUrl === pathToFileURL(path.resolve(argvPath)).href;
}
