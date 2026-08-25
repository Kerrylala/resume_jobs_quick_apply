import fs from 'fs';
import path from 'path';

import { createAIProvider } from './lib/ai_provider.mjs';
import { isMainModule, projectRootFromMetaUrl } from './lib/project_paths.mjs';
import { writeJsonAtomic } from './lib/json_repository.mjs';
import { normalizeCareerBrainStore } from './lib/career_brain.mjs';
import {
  buildHybridMatchResult,
  deterministicSemanticFallback,
  validateSemanticMatch
} from './lib/hybrid_matching.mjs';
import { appendAIUsageEvent } from './lib/ai_usage.mjs';

const root = projectRootFromMetaUrl(import.meta.url);
const dataDir = path.resolve(process.env.RESUME_JOBS_DATA_DIR || path.join(root, 'data'));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeJson(file, value) {
  writeJsonAtomic(file, value);
}

function validEnrichment(value) {
  const ok = value
    && typeof value === 'object'
    && typeof value.summary === 'string'
    && Array.isArray(value.skill_matches)
    && Array.isArray(value.gaps)
    && Number.isFinite(Number(value.confidence));
  return ok ? { ok: true } : {
    ok: false,
    errors: ['Expected summary, skill_matches, gaps, and numeric confidence.']
  };
}

function deterministicFallback(job) {
  return {
    summary: String(job.score_explanation || job.match_reason || 'Deterministic scoring completed.'),
    skill_matches: Array.isArray(job.strengths) ? job.strengths.map(String).slice(0, 8) : [],
    gaps: Array.isArray(job.gaps) ? job.gaps.map(String).slice(0, 8) : [],
    confidence: 0
  };
}

export async function enrichJobsWithLocalModel({
  jobs = [],
  provider,
  searchPreferences = {},
  careerProfile = null,
  maxJobs = 20,
  now = () => new Date().toISOString()
} = {}) {
  if (!provider || typeof provider.structuredTask !== 'function') {
    throw new TypeError('An AI provider is required.');
  }
  const output = [];
  const usageEvents = [];
  let modelUsedCount = 0;
  for (const job of jobs.slice(0, Math.max(0, Number(maxJobs) || 0))) {
    const deterministicFallback = deterministicSemanticFallback(job);
    // A configured-but-unreachable provider is the ordinary case: the user
    // closed LM Studio, or the endpoint is wrong. structuredTask throws on a
    // network or configuration failure, so without this the whole enrichment
    // run aborts and every job already processed is lost. AI is an optional
    // enhancement — a job that could not be enriched keeps its deterministic
    // score and says so, and the run finishes.
    let result;
    try {
      result = await provider.structuredTask({
      task: 'semantic_job_match',
      input: {
        job: {
          title: String(job.title || ''),
          company: String(job.company || ''),
          location: String(job.location || ''),
          description: String(job.description_text || '').slice(0, 6000),
          deterministic_score: Number(job.match_score || 0),
          deterministic_strengths: Array.isArray(job.strengths) ? job.strengths : [],
          deterministic_gaps: Array.isArray(job.gaps) ? job.gaps : []
        },
        search_goal: {
          active_search_profile_id: String(searchPreferences.active_search_profile_id || ''),
          target_roles: searchPreferences.target_roles || [],
          required_skills: searchPreferences.required_skills || [],
          preferred_skills: searchPreferences.preferred_skills || []
        },
        career_brain: careerProfile ? {
          profile_id: String(careerProfile.id || ''),
          career_goals: careerProfile.career_goals || [],
          skills: careerProfile.skills || {},
          experience: (careerProfile.experience || []).map(item => ({
            company: item.company || '', role: item.role || '', achievements: item.achievements || [], technologies: item.technologies || []
          })),
          projects: (careerProfile.projects || []).map(item => ({
            name: item.name || '', technologies: item.technologies || [], results: item.results || []
          })),
          job_preferences: careerProfile.job_preferences || {}
        } : null
      },
      schema: validateSemanticMatch,
      fallback: deterministicFallback
      });
    } catch (error) {
      result = {
        status: 'fallback',
        value: deterministicFallback,
        model_used: false,
        provider: provider.config?.type || '',
        model: '',
        response_format: '',
        unavailable_reason: error?.category || 'provider_error'
      };
    }
    if (result.model_used === true) modelUsedCount += 1;
    if (result.model_used === true) {
      usageEvents.push({
        task: 'semantic_job_match',
        provider: result.provider,
        model: result.model,
        response_format: result.response_format,
        status: result.status,
        latency_ms: result.latency_ms,
        ...(result.usage || {})
      });
    }
    const hybridMatch = buildHybridMatchResult(job, result.value, {
      provider: result.provider || 'disabled',
      model: result.model || '',
      modelUsed: result.model_used === true,
      responseFormat: result.response_format || '',
      now: now()
    });
    output.push({
      ...job,
      hybrid_match: hybridMatch,
      ai_enrichment: {
        summary: hybridMatch.career_reason,
        skill_matches: hybridMatch.strengths,
        gaps: [...hybridMatch.weaknesses, ...hybridMatch.missing],
        confidence: hybridMatch.confidence,
        source: result.model_used === true ? `ai_provider:${result.provider || 'configured'}` : 'deterministic_fallback',
        provider: result.provider || 'disabled',
        model_used: result.model_used === true,
        response_format: result.response_format || '',
        enriched_at: now()
      }
    });
  }
  return {
    jobs: [...output, ...jobs.slice(output.length)],
    result: {
      status: 'completed',
      run_type: 'ai-enrichment',
      jobs_considered: output.length,
      jobs_enriched: modelUsedCount,
      usage_events: usageEvents,
      deterministic_scores_changed: false,
      provider_availability_changed: false
    }
  };
}

export async function runLocalModelEnrichment() {
  const jobsPath = path.join(dataDir, 'jobs_shortlist.json');
  const jobs = readJson(jobsPath, []);
  const searchPreferences = readJson(path.join(dataDir, 'search_preferences.json'), {});
  const careerBrain = normalizeCareerBrainStore(readJson(path.join(dataDir, 'career_profiles.local.json'), {}));
  const careerProfile = careerBrain.profiles.find(profile => profile.id === careerBrain.active_profile_id) || null;
  const savedProviderSettings = readJson(path.join(dataDir, 'ai_provider.local.json'), null);
  const provider = createAIProvider(savedProviderSettings
    ? { env: {}, config: savedProviderSettings }
    : {});
  const enriched = await enrichJobsWithLocalModel({
    jobs: Array.isArray(jobs) ? jobs : [],
    provider,
    searchPreferences,
    careerProfile
  });
  writeJson(jobsPath, enriched.jobs);
  if (enriched.result.usage_events.length) {
    const usagePath = path.join(dataDir, 'ai_usage.local.json');
    let usageStore = readJson(usagePath, {});
    for (const event of enriched.result.usage_events) usageStore = appendAIUsageEvent(usageStore, event).store;
    writeJson(usagePath, usageStore);
  }
  return enriched.result;
}

if (isMainModule(import.meta.url)) {
  runLocalModelEnrichment()
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(error?.message || String(error));
      process.exitCode = 1;
    });
}
