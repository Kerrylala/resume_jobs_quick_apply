import fs from 'node:fs';
import path from 'node:path';

import { createAIProvider, AIProviderError } from './lib/ai_provider.mjs';
import { isMainModule, projectRootFromMetaUrl } from './lib/project_paths.mjs';

const ROOT = projectRootFromMetaUrl(import.meta.url);

export function loadSavedAIProviderSettings({
  dataDir = process.env.RESUME_JOBS_DATA_DIR || path.join(ROOT, 'data')
} = {}) {
  const settingsPath = path.join(path.resolve(dataDir), 'ai_provider.local.json');
  if (!fs.existsSync(settingsPath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('settings must be a JSON object');
    }
    return value;
  } catch (error) {
    throw new AIProviderError('configuration', `Saved AI provider settings are invalid: ${error.message}`);
  }
}

export async function checkLocalModel(options = {}) {
  const { dataDir, ...providerOptions } = options;
  const hasExplicitConfig = Object.hasOwn(options, 'config');
  const savedSettings = hasExplicitConfig ? null : loadSavedAIProviderSettings({ dataDir });
  const provider = createAIProvider(savedSettings
    ? { ...providerOptions, env: {}, config: savedSettings }
    : providerOptions);
  return provider.healthCheck();
}

if (isMainModule(import.meta.url)) {
  checkLocalModel()
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(JSON.stringify({
        status: 'failed',
        code: error instanceof AIProviderError ? error.code : 'ERROR',
        category: error.category || 'unknown',
        message: error.message
      }, null, 2));
      process.exitCode = 1;
    });
}
