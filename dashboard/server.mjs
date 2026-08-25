import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile, execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';
import {
  approvalSafetyErrorDetails,
  createApprovalSafety,
  evaluateApplicationDecision
} from '../scripts/lib/approval_safety.mjs';
import {
  SearchPreferencesValidationError,
  defaultSearchPreferences,
  normalizeSearchPreferences
} from '../scripts/lib/search_preferences.mjs';
import {
  buildUploadedResumeProfile,
  MAX_RESUME_UPLOAD_BYTES,
  matchesResumeContentHash,
  normalizeAnswerMemory,
  normalizeQuestion,
  normalizeResumeProfiles as normalizeResumeProfileRecords,
  ResumeUploadValidationError,
  selectBestResumeProfile,
  validateResumeUpload,
  upsertAnswerMemory,
  upsertAnswerMemoryWithResult
} from '../scripts/lib/candidate_records.mjs';
import {
  APPLICATION_STATUSES,
  applicationAllowedTransitions,
  appendAuditEvent,
  completeApplicationReview,
  computeReviewBlockers,
  sessionResumeUploadConfirmed,
  deriveApplicationStatus,
  reviewScanFreshness,
  normalizeApplicationExecutionState,
  normalizeApplicationStatus,
  prepareApplicationExecutionSession,
  recordApplicationExecutionSessionReport,
  recordApplicationReviewRescan,
  recoverLegacyApplicationExecutionState,
  restartApplicationExecutionSetup,
  startApplicationExecutionSession,
  transitionApplicationState
} from '../scripts/lib/application_state.mjs';
import { deriveSessionLiveness } from '../scripts/lib/session_liveness.mjs';
import { buildApplicationProfileView } from '../scripts/lib/application_profile_view.mjs';
import {
  aiTailoringInput,
  buildDeterministicDraft,
  verifyDraftCoverage,
  buildKeywordCoverage,
  mergeAiTailoring,
  validateDraftGrounding,
  validateResumeTailoringOutput
} from '../scripts/lib/resume_tailoring.mjs';
import {
  aiCoverLetterInput,
  buildDeterministicCoverLetter,
  mergeAiCoverLetter,
  validateCoverLetterGrounding,
  validateCoverLetterOutput
} from '../scripts/lib/cover_letter.mjs';
import { discoverCompanyJobs } from '../scripts/lib/company_careers.mjs';
import { buildResumeDocx } from '../scripts/lib/docx_writer.mjs';
import { draftRenderModel, resumeTemplate, detectResumeTemplateForModel, CLASSIC_CN_TITLES } from '../scripts/lib/resume_render.mjs';
import { buildApplicationPackagePreview } from '../scripts/build_application_package_preview.mjs';
import { aggregateCompletionInsights } from '../scripts/lib/application_completion.mjs';
import {
  applyResumeFactSuggestions,
  activateCandidateProfileVersion,
  buildResumeIntelligence,
  candidateFactSchema,
  confirmCandidateProfileSnapshot,
  createCandidateProfileVersion,
  deleteCandidateProfileVersion,
  listCandidateProfileVersions,
  mutateCandidateFact,
  persistResumeAnalysisDraft,
  prepareResumeSuggestionTargets
} from '../scripts/lib/resume_intelligence.mjs';
import {
  buildWorkflowState,
  searchConfigurationFingerprint
} from '../scripts/lib/workflow_state.mjs';
import {
  analyzeResumeDocumentRobust,
  extractDocxText,
  extractPdfTextRobust,
  ResumeDocumentAnalysisError
} from '../scripts/lib/resume_document_intelligence.mjs';
import {
  canonicalizeJobUrl,
  categorizeJobSource,
  isSuppressedFromDefaultResults,
  mergeJobRecords,
  normalizeJobRecord
} from '../scripts/lib/job_records.mjs';
import { canonicalMatchScores } from '../scripts/lib/hybrid_matching.mjs';
import { ingestPublicJobUrl, JobUrlIngestionError } from '../scripts/lib/job_url_ingestion.mjs';
import { classifyJobInput, jobQualityGate } from '../scripts/lib/job_input_classifier.mjs';
import { searchSearxng } from '../providers/searxng_search/index.mjs';
import { normalizeSearchPlanStore, upsertSearchPlan, deleteSearchPlan, normalizeSearchCriteria } from '../scripts/lib/search_criteria.mjs';
import { runGlobalSearch } from '../scripts/lib/search_orchestrator.mjs';
import { buildSearchQueries } from '../scripts/lib/search_planner.mjs';
import { deriveRoles, extractSkills, profileLocations } from '../scripts/lib/profile_signals.mjs';
import { classifyPageType } from '../scripts/score_jobs.mjs';
import { capabilityReport, browserAdapters } from '../providers/discovery/registry.mjs';
import { filterJobs } from '../scripts/lib/job_filter_engine.mjs';
import { matchingContextFromCareerProfile, scoreJobForSearch } from '../scripts/lib/search_matching.mjs';
import { writeJsonAtomic } from '../scripts/lib/json_repository.mjs';
import { buildOfflineDemoDiscovery } from '../scripts/lib/offline_demo_jobs.mjs';
import {
  buildLocalMockAtsHandoffUrl,
  buildLocalMockFillProfile,
  isLocalMockAtsUrl
} from '../scripts/lib/mock_ats_demo.mjs';
import {
  effectiveJobSearchProvider,
  normalizeJobSearchSources,
  publicJobSearchSources,
  SEARXNG_PROVIDER_ID,
  testSearxngConnection,
  validateSearchProviderUrl
} from '../scripts/lib/job_search_sources.mjs';
import {
  AI_PROVIDER_PRESETS,
  AIProviderError,
  createAIProvider,
  detectLocalAIProviders,
  normalizeAIProviderSettings,
  publicAIProviderSettings
} from '../scripts/lib/ai_provider.mjs';
import {
  activateCareerProfile,
  approveCareerProfile,
  archiveCareerProfile,
  careerProfileFromCandidateProfile,
  createCareerProfile,
  duplicateCareerProfile,
  importCareerProfile,
  normalizeCareerBrainStore,
  normalizeCareerProfile,
  publicCareerBrainSummary,
  saveCareerProfileVersion
} from '../scripts/lib/career_brain.mjs';
import { appendAIUsageEvent, summarizeAIUsage } from '../scripts/lib/ai_usage.mjs';
import { agentBrowserCandidates } from '../scripts/lib/agent_browser.mjs';
import { buildJobSearchPlan } from '../scripts/lib/job_search_agent.mjs';
import { EXECUTOR_MODES, normalizeExecutorMode } from '../application_executor/executor_interface.mjs';
import { withinApplicationScope } from '../application_executor/safety_policy.mjs';
import {
  approvedProfileVersionFromPackage,
  assertApplicationExecutionSession,
  createApplicationExecutionSession,
  transitionApplicationExecutionSession
} from '../application_executor/execution_session.mjs';
import {
  buildLearningCandidates,
  confirmFormFieldMapping,
  decideLearningCandidate,
  finalizeLearningCandidate,
  learningCandidatesFor,
  normalizeFormFieldMemory,
  normalizeLearningCandidateStore,
  recordLearningCandidates
} from '../scripts/lib/learning_candidates.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CUSTOM_DATA_DIR = Boolean(String(process.env.RESUME_JOBS_DATA_DIR || '').trim());
const DATA_DIR = path.resolve(process.env.RESUME_JOBS_DATA_DIR || path.join(PROJECT_ROOT, 'data'));
const REPORTS_DIR = path.resolve(process.env.RESUME_JOBS_REPORTS_DIR || path.join(PROJECT_ROOT, 'reports'));
const APPLICATIONS_DIR = path.resolve(process.env.RESUME_JOBS_APPLICATIONS_DIR || path.join(PROJECT_ROOT, 'applications'));
const CONFIGURED_PROFILE_PATH = process.env.RESUME_JOBS_PROFILE_PATH
  ? path.resolve(process.env.RESUME_JOBS_PROFILE_PATH)
  : '';
const ARCHIVE_DIR = path.resolve(process.env.RESUME_JOBS_ARCHIVE_DIR || path.join(PROJECT_ROOT, 'archive'));
// Parent of every generated candidate document. The resume library keeps its
// own override for backward compatibility with existing installs.
const DOCUMENTS_DIR = path.resolve(
  process.env.RESUME_JOBS_DOCUMENTS_DIR || path.join(PROJECT_ROOT, 'documents')
);
const RESUME_LIBRARY_DIR = path.resolve(
  process.env.RESUME_JOBS_RESUME_LIBRARY_DIR || path.join(DOCUMENTS_DIR, 'resumes')
);
const BROWSER_PROFILES_DIR = path.resolve(
  process.env.RESUME_JOBS_BROWSER_PROFILES_DIR || path.join(PROJECT_ROOT, 'browser_profiles')
);
const BROWSER_SESSIONS_DIR = path.resolve(
  process.env.RESUME_JOBS_BROWSER_SESSIONS_DIR || path.join(PROJECT_ROOT, 'browser_sessions')
);
const AI_PROVIDER_SETTINGS_PATH = path.join(DATA_DIR, 'ai_provider.local.json');
const CAREER_BRAIN_PATH = path.join(DATA_DIR, 'career_profiles.local.json');
const AI_USAGE_PATH = path.join(DATA_DIR, 'ai_usage.local.json');
const LEARNING_CANDIDATES_PATH = path.join(DATA_DIR, 'learning_candidates.local.json');
const FORM_FIELD_MEMORY_PATH = path.join(DATA_DIR, 'form_field_memory.local.json');

const PORT = Number(process.env.PORT || 8767);
const HOST = '127.0.0.1';
const SHUTDOWN_TOKEN = String(process.env.RESUME_JOBS_SHUTDOWN_TOKEN || '');
const VALID_DECISIONS = new Set(['approved', 'rejected', 'manual_review', 'pending', 'restore', 'reconsider']);
const VALID_APPLICATION_STATUSES = new Set(APPLICATION_STATUSES);

let runningJob = null;
const browserAgentProcesses = new Map();
const extensionConnections = new Map();
const EXTENSION_CONNECTION_TTL_MS = Math.max(5_000, Number(process.env.EXECUTOR_CONNECTION_TTL_MS) || 30_000);
const SESSION_STALE_TTL_MS = Math.max(60_000, Number(process.env.SESSION_STALE_TTL_MS) || 10 * 60 * 1000);

function latestExtensionLastSeenMs() {
  let latest = null;
  for (const record of extensionConnections.values()) {
    const parsed = Date.parse(record?.last_seen || '');
    if (Number.isFinite(parsed) && (latest === null || parsed > latest)) latest = parsed;
  }
  return latest;
}

function sessionLivenessSnapshot(session, { agentStatus = {} } = {}) {
  const browserAgentPid = Number(session?.browser_agent?.process_id || 0);
  const browserAgentPidAlive = browserAgentPid > 0 && (() => {
    try { process.kill(browserAgentPid, 0); return true; } catch { return false; }
  })();
  return deriveSessionLiveness({
    session,
    extensionLastSeenMs: latestExtensionLastSeenMs(),
    browserAgentPidAlive,
    agentStatusUpdatedAt: agentStatus?.updated_at || null,
    now: Date.now(),
    connectionTtlMs: EXTENSION_CONNECTION_TTL_MS,
    sessionStaleTtlMs: SESSION_STALE_TTL_MS
  });
}
const dashboardEventClients = new Set();
let dashboardEventSequence = 0;

function publishDashboardEvent(eventType, details = {}) {
  const event = {
    sequence: ++dashboardEventSequence,
    event_type: String(eventType || 'STATE_CHANGED'),
    timestamp: new Date().toISOString(),
    job_id: String(details.job_id || ''),
    application_id: String(details.application_id || ''),
    session_id: String(details.session_id || ''),
    status: String(details.status || ''),
    message: String(details.message || '')
  };
  const payload = `id: ${event.sequence}\nevent: dashboard-update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of [...dashboardEventClients]) {
    try { client.write(payload); }
    catch { dashboardEventClients.delete(client); }
  }
  return event;
}

function handleDashboardEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`retry: 3000\nevent: dashboard-update\ndata: ${JSON.stringify({
    sequence: dashboardEventSequence,
    event_type: 'CONNECTED',
    timestamp: new Date().toISOString()
  })}\n\n`);
  dashboardEventClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(`: keepalive ${Date.now()}\n\n`); }
    catch { clearInterval(heartbeat); dashboardEventClients.delete(res); }
  }, 20_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    dashboardEventClients.delete(res);
  });
}

function dataPath(name) {
  return path.join(DATA_DIR, name);
}

function readJSON(filePath, fallback) {
  const hasFallback = arguments.length >= 2;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return hasFallback ? fallback : null;
    const fileName = path.basename(filePath);
    console.error(JSON.stringify({
      event: 'local_data_read_failed',
      file_name: fileName,
      error_code: String(err?.code || err?.name || 'JSON_READ_FAILED')
    }));
    const safeError = new Error(`Local data file ${fileName} could not be read safely. Restore it from a backup or use Reset Local Data.`);
    safeError.code = 'LOCAL_DATA_READ_FAILED';
    throw safeError;
  }
}

function defaultCandidateProfile() {
  return readJSON(
    path.join(PROJECT_ROOT, 'extensions', 'application_assistant', 'profile.local.template.json'),
    {
      approved_for_real_applications: false,
      review_required_before_real_applications: true,
      profile_type: 'real_user_profile',
      allow_autofill_real_sites: false,
      allow_resume_attach: false,
      allow_final_submit: false
    }
  );
}

function writeJSON(filePath, data) {
  writeJsonAtomic(filePath, data);
}

function writePrivateJSON(filePath, data) {
  writeJsonAtomic(filePath, data, { mode: 0o600 });
}

function savedAIProviderSettings() {
  return readJSON(AI_PROVIDER_SETTINGS_PATH, null);
}

function configuredAIProvider() {
  const saved = savedAIProviderSettings();
  return createAIProvider(saved ? { env: {}, config: saved } : {});
}

function configuredAIProviderStatus() {
  return publicAIProviderSettings(savedAIProviderSettings());
}

function readCareerBrainStore() {
  return normalizeCareerBrainStore(readJSON(CAREER_BRAIN_PATH, {}));
}

function writeCareerBrainStore(store) {
  writePrivateJSON(CAREER_BRAIN_PATH, normalizeCareerBrainStore(store));
}

function readLearningCandidateStore() {
  return normalizeLearningCandidateStore(readJSON(LEARNING_CANDIDATES_PATH, {}));
}

function writeLearningCandidateStore(store) {
  writePrivateJSON(LEARNING_CANDIDATES_PATH, normalizeLearningCandidateStore(store));
}

function readFormFieldMemory() {
  return normalizeFormFieldMemory(readJSON(FORM_FIELD_MEMORY_PATH, {}));
}

function writeFormFieldMemory(memory) {
  writePrivateJSON(FORM_FIELD_MEMORY_PATH, normalizeFormFieldMemory(memory));
}

function recordAIUsage(task, result) {
  if (result?.model_used !== true) return null;
  const appended = appendAIUsageEvent(readJSON(AI_USAGE_PATH, {}), {
    task,
    provider: result.provider,
    model: result.model,
    response_format: result.response_format,
    status: result.status,
    latency_ms: result.latency_ms,
    ...(result.usage || {})
  });
  writePrivateJSON(AI_USAGE_PATH, appended.store);
  return appended.event;
}

function careerExtractionSchema(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const requiredArrays = ['education', 'experience', 'projects', 'certifications', 'languages', 'career_goals'];
  const ok = Boolean(
    source
    && source.identity && typeof source.identity === 'object' && !Array.isArray(source.identity)
    && source.skills && typeof source.skills === 'object' && !Array.isArray(source.skills)
    && requiredArrays.every(key => Array.isArray(source[key]))
    && Number.isFinite(Number(source.confidence))
  );
  return { ok, errors: ok ? [] : ['Career Profile extraction did not match the required structured contract.'] };
}

async function buildCareerBrainDraft({ candidateProfile, resumeProfile, resumeText = '', allowAI = false }) {
  const now = new Date().toISOString();
  const deterministic = careerProfileFromCandidateProfile(candidateProfile, {
    resumeId: resumeProfile.resume_id,
    name: resumeProfile.name || 'Resume Career Profile',
    now
  });
  const provider = configuredAIProvider();
  if (!allowAI || provider.config.enabled !== true || !String(resumeText || '').trim()) {
    return {
      profile: deterministic,
      ai: {
        status: allowAI ? 'provider_disabled' : 'not_authorized_for_this_upload',
        model_used: false,
        provider: provider.config.type || 'disabled',
        raw_text_persisted: false
      }
    };
  }
  try {
    const enriched = await provider.structuredTask({
      task: 'career_profile_extraction',
      input: {
        resume_text: String(resumeText).slice(0, 60_000)
      },
      schema: careerExtractionSchema,
      fallback: deterministic
    });
    recordAIUsage('career_profile_extraction', enriched);
    const model = enriched.value || {};
    const profile = normalizeCareerProfile({
      ...deterministic,
      identity: { ...deterministic.identity, ...(model.identity || {}) },
      education: model.education?.length ? model.education : deterministic.education,
      experience: model.experience?.length ? model.experience : deterministic.experience,
      projects: model.projects?.length ? model.projects : deterministic.projects,
      skills: { ...deterministic.skills, ...(model.skills || {}) },
      certifications: model.certifications?.length ? model.certifications : deterministic.certifications,
      languages: model.languages?.length ? model.languages : deterministic.languages,
      career_goals: model.career_goals?.length ? model.career_goals : deterministic.career_goals,
      state: 'draft',
      user_approved: false,
      approved_at: null,
      updated_at: now
    }, { now });
    return {
      profile,
      ai: {
        status: enriched.status,
        model_used: enriched.model_used === true,
        provider: enriched.provider,
        model: enriched.model || '',
        response_format: enriched.response_format || '',
        confidence: Number(model.confidence) || 0,
        raw_text_persisted: false
      }
    };
  } catch (error) {
    return {
      profile: deterministic,
      ai: {
        status: 'fallback_after_error',
        model_used: false,
        provider: provider.config.type || '',
        error: error?.message || 'AI Career Profile extraction failed.',
        raw_text_persisted: false
      }
    };
  }
}

function publicConfiguredJobSearchSources(input) {
  const sources = publicJobSearchSources(input);
  sources.ai_enrichment = configuredAIProviderStatus();
  return sources;
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupFile(filePath) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const base = path.basename(filePath);
  const backupPath = path.join(ARCHIVE_DIR, `${base}.${timestampForFile()}.bak`);
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
  } else {
    fs.writeFileSync(backupPath, '', 'utf8');
  }
  return path.relative(PROJECT_ROOT, backupPath);
}

function ensureStateFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // jobs_approved.json / jobs_rejected.json were dead stores: seeded at boot,
  // never read or written anywhere else. Retired — job decisions live in
  // job_reviews.json; existing files are left untouched for rollback.
  if (!fs.existsSync(dataPath('job_reviews.json'))) writeJSON(dataPath('job_reviews.json'), []);
  if (!fs.existsSync(dataPath('dashboard_state.json'))) {
    writeJSON(dataPath('dashboard_state.json'), {
      version: '1.1.0',
      created_at: new Date().toISOString(),
      application_status_overrides: {},
      run_history: []
    });
  }
  if (!fs.existsSync(dataPath('resume_profiles.json'))) {
    writeJSON(dataPath('resume_profiles.json'), defaultResumeProfiles());
  }
}

ensureStateFiles();

const RESET_CONFIRMATION_TEXT = 'RESET LOCAL DATA';

function validateResetDirectory(directoryPath, label) {
  const resolved = path.resolve(directoryPath);
  const projectRelative = path.relative(resolved, PROJECT_ROOT);
  const containsProjectRoot = projectRelative !== ''
    && !projectRelative.startsWith('..')
    && !path.isAbsolute(projectRelative);
  const denied = new Set([
    path.parse(resolved).root,
    path.resolve(PROJECT_ROOT),
    path.resolve(os.homedir())
  ]);
  if (denied.has(resolved) || containsProjectRoot || resolved.length <= path.parse(resolved).root.length) {
    const error = new Error(`${label} resolves to an unsafe reset target.`);
    error.code = 'UNSAFE_RESET_TARGET';
    throw error;
  }
  return resolved;
}

function clearDirectoryContents(directoryPath, { preserve = [] } = {}) {
  const preserved = new Set(preserve);
  if (!fs.existsSync(directoryPath)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (preserved.has(entry.name)) continue;
    const target = path.join(directoryPath, entry.name);
    fs.rmSync(target, { recursive: entry.isDirectory(), force: true });
    removed.push(target);
  }
  return removed;
}

const CLEAR_JOB_MATERIALS_CONFIRMATION_TEXT = 'CLEAR JOB MATERIALS';

// Application statuses whose per-job record is part of the user's application
// history rather than their job-seeking materials. "Clear job materials" keeps
// these so the user never loses the record of what they already applied to.
const APPLICATION_HISTORY_STATUSES = new Set([
  'MANUALLY_SUBMITTED',
  'SUBMITTED',
  'READY_FOR_MANUAL_SUBMIT'
]);

// Files that hold the user's job-seeking materials: the online profile, the
// parsed resume registry, saved answers, learned field rules. Jobs, job
// decisions and application history are deliberately absent — see
// clearJobMaterials().
const JOB_MATERIAL_DATA_FILES = [
  'career_profiles.local.json',
  'candidate_profile.local.json',
  'resume_profiles.json',
  'question_bank.json',
  'form_field_memory.local.json',
  'learning_candidates.local.json'
];

// Deletes the user's job-seeking materials while preserving their application
// history. This is the softer of the two delete actions; the harder one is
// resetLocalData().
function clearJobMaterials() {
  const removed = [];
  const backups = [];

  for (const name of JOB_MATERIAL_DATA_FILES) {
    const filePath = dataPath(name);
    if (!fs.existsSync(filePath)) continue;
    backups.push(backupFile(filePath));
    fs.rmSync(filePath, { force: true });
    removed.push({ label: 'profile_data', target: filePath });
  }

  // Prepared application working directories and generated documents are
  // materials, not history. The history lives in dashboard_state.json.
  for (const [label, directory] of [
    ['applications', APPLICATIONS_DIR],
    ['resume_library', RESUME_LIBRARY_DIR],
    ['resume_drafts', path.join(DOCUMENTS_DIR, 'resume_drafts')],
    ['cover_letters', path.join(DOCUMENTS_DIR, 'cover_letters')]
  ]) {
    if (!fs.existsSync(directory)) continue;
    const validated = validateResetDirectory(directory, label);
    removed.push(...clearDirectoryContents(validated).map(target => ({ label, target })));
  }

  for (const [label, name] of [['resume_draft_index', 'resume_drafts'], ['cover_letter_store', 'cover_letters']]) {
    const directory = dataPath(name);
    if (!fs.existsSync(directory)) continue;
    const validated = validateResetDirectory(directory, label);
    removed.push(...clearDirectoryContents(validated).map(target => ({ label, target })));
  }

  // Keep application history; drop the in-flight execution state that refers to
  // materials that no longer exist.
  const statePath = dataPath('dashboard_state.json');
  backups.push(backupFile(statePath));
  const state = getDashboardState();
  const overrides = state.application_status_overrides || {};
  const keptOverrides = {};
  let droppedApplications = 0;
  for (const [jobId, record] of Object.entries(overrides)) {
    const status = normalizeApplicationStatus(record?.application_status || '');
    if (!APPLICATION_HISTORY_STATUSES.has(status)) {
      droppedApplications += 1;
      continue;
    }
    // The record stays, but its links into deleted packages and sessions do not.
    const { active_session_id: _session, latest_review_rescan: _scan, ...history } = record;
    keptOverrides[jobId] = history;
  }
  state.application_status_overrides = keptOverrides;
  state.application_execution_sessions = {};

  const clearedAt = new Date().toISOString();
  state.local_reset_epoch = `${clearedAt}:${process.pid}`;
  state.local_reset_at = clearedAt;
  state.local_reset_scope = 'job_materials_only';
  writeJSON(statePath, state);

  ensureStateFiles();

  return {
    cleared_at: clearedAt,
    reset_epoch: state.local_reset_epoch,
    removed_count: removed.length,
    removed_categories: [...new Set(removed.map(item => item.label))].sort(),
    backups,
    preserved: {
      application_history_count: Object.keys(keptOverrides).length,
      in_flight_applications_discarded: droppedApplications,
      job_decisions: true,
      discovered_jobs: true,
      audit_events: true
    }
  };
}

function resetLocalData() {
  const resetDirectories = [
    ['data', DATA_DIR],
    ['reports', REPORTS_DIR],
    ['applications', APPLICATIONS_DIR],
    ['resume_library', RESUME_LIBRARY_DIR],
    ['browser_profiles', BROWSER_PROFILES_DIR],
    ['browser_sessions', BROWSER_SESSIONS_DIR]
  ].map(([label, directory]) => [label, validateResetDirectory(directory, label)]);
  const resumeState = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles())).value;
  const activeResumeId = resumeState.active_resume_id || resumeState.active_resume_profile_id;
  const activeResume = resumeState.items.find(item => item.resume_id === activeResumeId || item.id === activeResumeId) || null;
  const profilePath = candidateProfilePath(activeResume, { allowMissing: true });
  const removed = [];
  // The most destructive action in the product must still be recoverable:
  // archive every top-level data store BEFORE the wipe (archive/ itself is
  // never part of a reset). Without this, one misclick lost everything —
  // in a product that promises "nothing is ever deleted".
  const preWipeBackups = [];
  try {
    for (const entry of fs.readdirSync(DATA_DIR)) {
      if (!entry.endsWith('.json')) continue;
      if (entry === 'ai_provider.local.json') continue; // preserved, not wiped
      try { preWipeBackups.push(backupFile(path.join(DATA_DIR, entry))); }
      catch { /* a single unreadable store must not block the reset */ }
    }
  } catch { /* data dir may not exist on a first run */ }
  let externalProfilePreserved = false;
  for (const [label, directory] of resetDirectories) {
    // ai_provider.local.json is CONFIGURATION (which AI service to talk to),
    // not candidate data — wiping it silently disabled every AI feature after
    // a reset while the settings screen still looked connected.
    const preserve = directory === DATA_DIR ? ['README.md', '.gitkeep', 'ai_provider.local.json'] : [];
    removed.push(...clearDirectoryContents(directory, { preserve }).map(target => ({ label, target })));
  }
  if (profilePath && fs.existsSync(profilePath)) {
    const resolvedProfile = path.resolve(profilePath);
    const alreadyRemoved = removed.some(item => path.resolve(item.target) === resolvedProfile);
    const productOwnedStandaloneProfiles = new Set([
      path.resolve(PROJECT_ROOT, 'profile.local.json'),
      path.resolve(PROJECT_ROOT, 'extensions/application_assistant/profile.local.json')
    ]);
    if (!alreadyRemoved && !CONFIGURED_PROFILE_PATH && productOwnedStandaloneProfiles.has(resolvedProfile)) {
      fs.rmSync(resolvedProfile, { force: true });
      removed.push({ label: 'candidate_profile', target: resolvedProfile });
    } else if (!alreadyRemoved) {
      externalProfilePreserved = true;
    }
  }
  ensureStateFiles();
  const resetAt = new Date().toISOString();
  const state = getDashboardState();
  state.local_reset_epoch = `${resetAt}:${process.pid}`;
  state.local_reset_at = resetAt;
  state.local_reset_scope = 'all_product_local_data';
  writeJSON(dataPath('dashboard_state.json'), state);
  return {
    reset_at: resetAt,
    reset_epoch: state.local_reset_epoch,
    removed_count: removed.length,
    removed_categories: [...new Set(removed.map(item => item.label))].sort(),
    pre_wipe_backups: preWipeBackups,
    external_profile_preserved: externalProfilePreserved
  };
}

function sendJSON(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data, null, 2));
}

function sendFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch {
    sendJSON(res, {
      status: 'error',
      message: 'Static file not found',
      method: 'GET',
      path: path.relative(PROJECT_ROOT, filePath)
    }, 404);
  }
}

const STATIC_CONTENT_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
}));

// Serves one file out of a fixed directory. The resolved path is asserted to
// stay inside that directory, so a crafted URL cannot walk out of it with
// `..`, an encoded separator, or an absolute path.
function sendStaticFile(res, rootDirectory, relativePath) {
  const resolvedRoot = path.resolve(rootDirectory);
  const resolved = path.resolve(resolvedRoot, `.${path.posix.sep}${relativePath}`);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return sendJSON(res, { status: 'error', code: 'STATIC_PATH_FORBIDDEN', message: 'Not Found' }, 404);
  }
  let stats;
  try { stats = fs.statSync(resolved); }
  catch { return sendJSON(res, { status: 'error', code: 'STATIC_FILE_NOT_FOUND', message: 'Not Found' }, 404); }
  if (!stats.isFile()) {
    return sendJSON(res, { status: 'error', code: 'STATIC_FILE_NOT_FOUND', message: 'Not Found' }, 404);
  }
  const contentType = STATIC_CONTENT_TYPES.get(path.extname(resolved).toLowerCase())
    || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  return res.end(fs.readFileSync(resolved));
}

const QUICK_UI_DIR = path.join(__dirname, 'quick');
const ADVANCED_UI_DIR = path.join(__dirname, 'public');

// Quick Apply is the default experience; the original Dashboard stays reachable
// at /advanced, unchanged. Falls back to the old UI until the Quick Apply
// entry point exists, so the product is never left without a front end.
function handleStaticRequest(req, res, pathname) {
  const quickAvailable = fs.existsSync(path.join(QUICK_UI_DIR, 'index.html'));

  if (pathname === '/advanced' || pathname === '/advanced/') {
    return sendStaticFile(res, ADVANCED_UI_DIR, 'index.html');
  }
  if (pathname.startsWith('/advanced/')) {
    return sendStaticFile(res, ADVANCED_UI_DIR, pathname.slice('/advanced/'.length));
  }
  if (pathname === '/' || pathname === '/index.html') {
    return quickAvailable
      ? sendStaticFile(res, QUICK_UI_DIR, 'index.html')
      : sendStaticFile(res, ADVANCED_UI_DIR, 'index.html');
  }
  // The original Dashboard references these at the root; keep them working so
  // /advanced does not need its markup rewritten.
  if (pathname === '/app.js' || pathname === '/style.css') {
    return sendStaticFile(res, ADVANCED_UI_DIR, pathname.slice(1));
  }
  if (quickAvailable) {
    return sendStaticFile(res, QUICK_UI_DIR, pathname.slice(1));
  }
  return sendNotFound(req, res, pathname);
}

function sendNotFound(req, res, pathname) {
  const isApi = pathname.startsWith('/api/');
  const payload = {
    status: 'error',
    message: 'Not Found',
    method: req.method,
    path: pathname,
    supported_api_prefixes: [
      'GET /api/summary',
      'GET /api/jobs',
      'GET /api/provider-health',
      'GET /api/daily-automation/latest',
      'GET /api/settings',
      'GET /api/workflow-state',
      'GET /api/workflow',
      'GET /api/audit?job_id=:job_id',
      'GET /api/jobs/:job_id/application-package',
      'GET /api/extension/active-hosts',
      'POST /api/jobs/:job_id/fill-current-step',
      'GET /api/extension/active-handoff?url=:current_url',
      'GET /api/extension/diagnostics',
      'POST /api/extension/diagnostics',
      'GET /api/executor/status?job_id=:job_id',
      'GET /api/extension/local-state',
      'POST /api/settings/search-preferences',
      'POST /api/settings/job-search-sources',
      'POST /api/settings/job-search-sources/test',
      'POST /api/settings/ai-provider',
      'POST /api/settings/ai-provider/test',
      'POST /api/run/ai-enrichment',
      'POST /api/settings/resume-profiles',
      'POST /api/settings/resume-upload',
      'POST /api/settings/resume-profiles/:resume_id/manage',
      'GET /api/settings/resume-profiles/:resume_id/export',
      'POST /api/settings/resume-profiles/:resume_id/approve',
      'POST /api/settings/resume-profiles/:resume_id/analyze',
      'POST /api/settings/resume-profiles/:resume_id/apply-suggestions',
      'POST /api/settings/question-answer',
      'POST /api/settings/candidate-profile/facts',
      'POST /api/settings/candidate-profile/confirm',
      'POST /api/settings/candidate-profile/versions',
      'GET /api/career-brain',
      'POST /api/career-brain/profiles',
      'GET /api/career-brain/profiles/:profile_id/export',
      'POST /api/settings/reset-local-data',
      'POST /api/workflow/selection',
      'POST /api/run/discovery',
      'POST /api/jobs/import-url',
      'POST /api/run/scoring',
      'POST /api/run/approval-queue',
      'POST /api/jobs/:job_id/approve',
      'POST /api/jobs/:job_id/reject',
      'POST /api/jobs/:job_id/manual-review',
      'POST /api/jobs/:job_id/reset',
      'POST /api/jobs/:job_id/build-package-preview',
      'POST /api/jobs/:job_id/recover-execution',
      'POST /api/jobs/:job_id/restart-fill-setup',
      'POST /api/jobs/:job_id/executor-selection',
      'POST /api/jobs/:job_id/approve-fill',
      'POST /api/jobs/:job_id/start-fill',
      'POST /api/jobs/:job_id/fill-report',
      'POST /api/jobs/:job_id/package-ready',
      'POST /api/jobs/:job_id/autofill-tested',
      'POST /api/jobs/:job_id/submitted-manually',
      'POST /api/jobs/:job_id/failed'
    ]
  };

  if (isApi) return sendJSON(res, payload, 404);

  res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload, null, 2));
}


function defaultResumeProfiles() {
  return { active_resume_profile_id: '', items: [] };
}

function normalizeResumeProfiles(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.items)
    ? input
    : defaultResumeProfiles();
  const { value, warnings } = normalizeResumeProfileRecords(source);
  const items = value.items.map(normalized => {
    normalized.resume_file_status = normalized.resume_file_path
      ? (fs.existsSync(resolveProjectFileReference(normalized.resume_file_path)) ? 'exists' : 'missing')
      : 'not_set';
    normalized.profile_file_status = normalized.profile_file_path
      ? (fs.existsSync(resolveProjectFileReference(normalized.profile_file_path)) ? 'exists' : 'missing')
      : 'not_set';
    return normalized;
  }).filter(item => !(
    !item.content_hash
    && !item.approved_at
    && item.resume_file_status !== 'exists'
  ));
  const activeId = items.some(item =>
    item.resume_id === value.active_resume_profile_id
    && item.enabled !== false
    && !item.archived_at
  )
    ? value.active_resume_profile_id
    : '';
  return {
    value: {
      ...value,
      active_resume_profile_id: activeId,
      active_resume_id: activeId,
      items
    },
    warnings
  };
}

function resolveProjectFileReference(fileReference) {
  return path.isAbsolute(String(fileReference || ''))
    ? path.resolve(String(fileReference))
    : path.resolve(PROJECT_ROOT, String(fileReference || ''));
}

function isPathInsideDirectory(filePath, directoryPath) {
  const relative = path.relative(path.resolve(directoryPath), path.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function portableFileReference(filePath) {
  const relative = path.relative(PROJECT_ROOT, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.replaceAll(path.sep, '/')
    : path.resolve(filePath);
}

function persistedResumeProfiles(value) {
  return {
    active_resume_profile_id: value.active_resume_profile_id,
    items: value.items.map(({ resume_file_status, profile_file_status, ...item }) => item)
  };
}

function candidateProfilePath(activeResume = null, { allowMissing = false } = {}) {
  if (CONFIGURED_PROFILE_PATH) {
    return fs.existsSync(CONFIGURED_PROFILE_PATH) && fs.statSync(CONFIGURED_PROFILE_PATH).isFile()
      ? CONFIGURED_PROFILE_PATH
      : (allowMissing ? CONFIGURED_PROFILE_PATH : '');
  }
  const resumeProfilePath = activeResume?.profile_file_path
    ? path.resolve(PROJECT_ROOT, activeResume.profile_file_path)
    : '';
  if (resumeProfilePath) {
    return fs.existsSync(resumeProfilePath) && fs.statSync(resumeProfilePath).isFile()
      ? resumeProfilePath
      : (allowMissing ? resumeProfilePath : '');
  }
  const dataProfilePath = path.join(DATA_DIR, 'candidate_profile.local.json');
  if (CUSTOM_DATA_DIR) {
    return fs.existsSync(dataProfilePath) && fs.statSync(dataProfilePath).isFile()
      ? dataProfilePath
      : (allowMissing ? dataProfilePath : '');
  }
  const candidates = [
    dataProfilePath,
    path.join(PROJECT_ROOT, 'profile.local.json'),
    path.join(PROJECT_ROOT, 'extensions/application_assistant/profile.local.json')
  ];
  const existing = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || '';
  return existing || (allowMissing ? candidates[0] || '' : '');
}

function candidateProfileSourceLabel(filePath) {
  if (!filePath) return 'missing';
  const relative = path.relative(PROJECT_ROOT, filePath);
  return relative.startsWith('..') || path.isAbsolute(relative)
    ? 'configured_private_profile'
    : relative.replaceAll(path.sep, '/');
}

function productProcessEnv() {
  const resumes = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles())).value;
  const activeResumeId = resumes.active_resume_id || resumes.active_resume_profile_id;
  const activeResume = resumes.items.find(item => item.resume_id === activeResumeId || item.id === activeResumeId) || null;
  const profilePath = candidateProfilePath(activeResume, { allowMissing: true });
  return {
    ...process.env,
    RESUME_JOBS_DATA_DIR: DATA_DIR,
    RESUME_JOBS_REPORTS_DIR: REPORTS_DIR,
    RESUME_JOBS_APPLICATIONS_DIR: APPLICATIONS_DIR,
    RESUME_JOBS_ARCHIVE_DIR: ARCHIVE_DIR,
    RESUME_JOBS_RESUME_LIBRARY_DIR: RESUME_LIBRARY_DIR,
    ...(profilePath ? { RESUME_JOBS_PROFILE_PATH: profilePath } : {})
  };
}

function readCandidateIntelligence(activeResume) {
  const profilePath = candidateProfilePath(activeResume, { allowMissing: true });
  if (!profilePath) {
    return {
      profilePath: '',
      profile: null,
      intelligence: null,
      warning: 'Candidate profile file is missing.'
    };
  }
  const profileExists = fs.existsSync(profilePath);
  const profile = profileExists ? readJSON(profilePath, null) : {};
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return {
      profilePath,
      profile: null,
      intelligence: null,
      warning: 'Candidate profile file is not valid JSON.'
    };
  }
  return {
    profilePath,
    profile,
    intelligence: buildResumeIntelligence({ profile, selectedResume: activeResume }),
    warning: profileExists ? '' : 'Candidate profile will be created locally after the first Profile edit or approval.',
    profileExists
  };
}


function handleSettings(res) {
  const search = normalizeSearchPreferences(readJSON(dataPath('search_preferences.json'), defaultSearchPreferences()));
  const resumes = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles()));
  const jobSearchSources = publicConfiguredJobSearchSources(readJSON(dataPath('job_sources.json'), {}));
  const aiProvider = configuredAIProviderStatus();
  const questionBank = readJSON(dataPath('question_bank.json'), {});
  const activeSearch = search.value.search_profiles.find(profile => profile.id === search.value.active_search_profile_id) || null;
  const activeResume = resumes.value.items.find(item => item.resume_id === resumes.value.active_resume_id || item.id === resumes.value.active_resume_profile_id) || null;
  const candidate = readCandidateIntelligence(activeResume);
  const careerBrain = readCareerBrainStore();
  const activeCareerProfile = careerBrain.profiles.find(profile => profile.id === careerBrain.active_profile_id) || null;
  const answers = normalizeAnswerMemory(questionBank).answers;
  const workflowState = buildWorkflowState({
    searchPreferences: search.value,
    resumeProfiles: resumes.value,
    resumeIntelligence: candidate.intelligence,
    careerProfile: activeCareerProfile,
    searchRuns: readJSON(dataPath('search_runs.json'), []),
    jobs: getJobsWithOverlay()
  });
  const checks = {
    search_goal_configured: workflowState.facts.search_configured,
    search_completed: workflowState.facts.search_completed,
    resume_selected: Boolean(activeResume),
    resume_file_available: workflowState.facts.resume_uploaded,
    candidate_facts_available: Boolean(candidate.intelligence?.summary?.available_fact_count),
    candidate_facts_confirmed: workflowState.facts.profile_approved,
    answer_memory_started: answers.some(answer => answer && answer.user_confirmed === true)
  };
  const essentialKeys = [
    'search_goal_configured',
    'resume_selected',
    'resume_file_available',
    'candidate_facts_available',
    'candidate_facts_confirmed'
  ];
  const completedEssential = essentialKeys.filter(key => checks[key]).length;
  const productReadiness = {
    schema_version: '1.0',
    completion_percent: Math.round((completedEssential / essentialKeys.length) * 100),
    ready_to_search: checks.search_goal_configured,
    ready_to_build_application_package: workflowState.facts.job_approved,
    ready_to_fill_preview: essentialKeys.every(key => checks[key]),
    active_search_profile_id: activeSearch?.id || '',
    active_resume_id: activeResume?.resume_id || activeResume?.id || '',
    confirmed_answer_count: answers.filter(answer => answer && answer.user_confirmed === true).length,
    safe_reusable_answer_count: answers.filter(answer => answer && answer.approved_for_real_applications === true).length,
    checks
  };
  const jobSearchPlan = buildJobSearchPlan({
    careerProfile: activeCareerProfile || {},
    searchPreferences: search.value
  });
  sendJSON(res, {
    search_preferences: search.value,
    job_search_sources: jobSearchSources,
    ai_provider: aiProvider,
    ai_usage: summarizeAIUsage(readJSON(AI_USAGE_PATH, {})),
    resume_profiles: resumes.value,
    resume_intelligence: candidate.intelligence,
    candidate_profile: {
      source: candidateProfileSourceLabel(candidate.profilePath),
      available: candidate.profileExists !== false,
      can_confirm_snapshot: Boolean(candidate.intelligence?.summary?.available_fact_count),
      versions: listCandidateProfileVersions(candidate.profile || {})
    },
    career_brain: publicCareerBrainSummary(careerBrain),
    candidate_fact_schema: candidateFactSchema(),
    workflow_state: workflowState,
    product_readiness: productReadiness,
    job_search_plan: jobSearchPlan,
    question_bank_schema: questionBank.schema || null,
    question_bank_ui_schema: questionBank.ui_schema || null,
    warnings: [...search.warnings, ...resumes.warnings, ...(candidate.warning ? [candidate.warning] : [])]
  });
}

function handleCareerBrain(res) {
  sendJSON(res, publicCareerBrainSummary(readCareerBrainStore()));
}

function applicationProfileViewSnapshot() {
  const store = readCareerBrainStore();
  const activeProfile = store.profiles.find(profile => profile.id === store.active_profile_id) || null;
  return buildApplicationProfileView({
    careerProfile: activeProfile,
    // The legacy candidate profile is the fallback fact store: answers the
    // user gives in preflight for core facts (location, links, name parts…)
    // are persisted there, so a fact answered once is KNOWN from then on and
    // never asked again — without forcing a Career Profile re-approval.
    legacyProfile: readJSON(path.join(DATA_DIR, 'candidate_profile.local.json'), {}),
    answerMemory: readJSON(questionBankPath(), { answers: [] })
  });
}

function handleGetApplicationProfile(res) {
  sendJSON(res, { status: 'ok', ...applicationProfileViewSnapshot() });
}

// Fields the product must never auto-fill even when the user has entered them:
// they are policy or legal answers that have to be confirmed per application.
const ASK_EVERY_TIME_PREFERENCE_FIELDS = new Set([
  'work_authorization', 'sponsorship', 'salary', 'relocation_ok',
  'earliest_start_date', 'notice_period'
]);

// The whole online profile, in the shape "My materials" renders. This is a read
// model over the same active Career Profile the executor consumes — there is no
// second store and no second source of truth.
function fullProfileSnapshot() {
  const store = readCareerBrainStore();
  const active = store.profiles.find(profile => profile.id === store.active_profile_id) || null;
  const view = applicationProfileViewSnapshot();

  // Version lineage powers the undo affordance after a resume replaces the profile.
  const lineage = active
    ? store.profiles
      .filter(profile => profile.family_id === active.family_id)
      .sort((left, right) => right.version - left.version)
      .map(profile => ({
        profile_id: profile.id,
        version: profile.version,
        updated_at: profile.updated_at,
        approved: profile.user_approved === true,
        active: profile.id === active.id
      }))
    : [];
  const previous = lineage.find(entry => !entry.active && entry.version < (active?.version ?? 0)) || null;

  return {
    has_profile: Boolean(active),
    approved: view.approved,
    readiness: view.readiness,
    sections: active
      ? {
        identity: active.identity,
        job_preferences: active.job_preferences,
        education: active.education,
        experience: active.experience,
        projects: active.projects,
        skills: active.skills,
        certifications: active.certifications,
        languages: active.languages,
        career_goals: active.career_goals,
        interview_stories: active.interview_stories
      }
      : null,
    ask_every_time_fields: [...ASK_EVERY_TIME_PREFERENCE_FIELDS],
    version: active ? { profile_id: active.id, version: active.version, updated_at: active.updated_at } : null,
    history: lineage,
    can_undo: Boolean(previous),
    undo_target: previous
  };
}

function handleGetFullProfile(res) {
  sendJSON(res, { status: 'ok', ...fullProfileSnapshot() });
}

// Restores the previous version of the online profile. Uploading a new resume
// replaces the profile by appending a version, so "undo" is simply making the
// prior version active again — nothing is ever deleted.
async function handleUndoProfileVersion(req, res) {
  let body = {};
  try { body = await readRequestBody(req); }
  catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_PROFILE_UNDO_REQUEST', message: error.message }, 400);
  }
  const snapshot = fullProfileSnapshot();
  if (!snapshot.can_undo) {
    return sendJSON(res, {
      status: 'blocked', code: 'PROFILE_UNDO_UNAVAILABLE',
      message: 'There is no earlier version of your profile to go back to.'
    }, 409);
  }
  const targetId = String(body.profile_id || snapshot.undo_target.profile_id);
  const store = readCareerBrainStore();
  if (!store.profiles.some(profile => profile.id === targetId)) {
    return sendJSON(res, {
      status: 'error', code: 'CAREER_PROFILE_NOT_FOUND',
      message: 'That version of your profile no longer exists.'
    }, 404);
  }
  const backup = backupFile(CAREER_BRAIN_PATH);
  // activateCareerProfile returns { store, profile } — write the store, not the wrapper.
  const activated = activateCareerProfile(store, { profileId: targetId });
  writeCareerBrainStore(activated.store);
  sendJSON(res, { status: 'ok', backup, restored_profile_id: targetId, ...fullProfileSnapshot() });
}

// --- Tailored resume drafts -------------------------------------------------
//
// Generation happens ONLY through the POST handler below — no discovery,
// packaging or fill step calls it, so no tokens are ever spent without the
// user asking. Drafts live under data/resume_drafts/ (gitignored via data/*/).

const RESUME_DRAFTS_DIR = path.join(DATA_DIR, 'resume_drafts');

function resumeDraftPath(jobId) {
  const safe = String(jobId).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(RESUME_DRAFTS_DIR, `${safe}.json`);
}

function readResumeDraft(jobId) {
  const filePath = resumeDraftPath(jobId);
  if (!fs.existsSync(filePath)) return null;
  return readJSON(filePath, null);
}

// The tailored resume file for one job, if the user exported one. This is the
// single lookup preflight, apply-state and the Browser Agent session all use,
// so they can never point at different files for the same job.
function tailoredResumeFor(jobId) {
  const draft = readResumeDraft(jobId);
  if (!draft?.files?.docx) return null;
  const docxPath = path.resolve(PROJECT_ROOT, draft.files.docx);
  if (!fs.existsSync(docxPath)) return null;
  const pdfPath = draft.files.pdf ? path.resolve(PROJECT_ROOT, draft.files.pdf) : '';

  // Staleness: the profile moved on after this file was generated. The file is
  // still usable, but the user should know it no longer reflects their newest
  // confirmed facts.
  const store = readCareerBrainStore();
  const active = store.profiles.find(item => item.id === store.active_profile_id) || null;
  const staleProfile = Boolean(active
    && (active.id !== draft.profile_id || Number(active.version) !== Number(draft.profile_version)));

  return {
    job_id: String(jobId),
    draft_id: draft.draft_id,
    file_name: path.basename(docxPath),
    docx_path: docxPath,
    pdf_path: pdfPath && fs.existsSync(pdfPath) ? pdfPath : '',
    docx_sha256: draft.files.docx_sha256 || '',
    pdf_sha256: draft.files.pdf_sha256 || '',
    profile_version: draft.profile_version,
    generated_at: draft.files.exported_at || draft.generated_at,
    stale_profile: staleProfile,
    // False when the export-time completeness check found dropped entries.
    content_complete: draft.coverage ? draft.coverage.complete === true : null,
    coverage_warnings: draft.coverage?.warnings || []
  };
}

// Streams an exported tailored-resume file. This serves EXACTLY the file the
// fill session would upload for this job — same tailoredResumeFor lookup, same
// paths — so what the user previews/downloads is what the portal receives.
function handleDownloadResumeDraftFile(res, jobId, format) {
  const tailored = tailoredResumeFor(jobId);
  const wantsPdf = String(format || '').toLowerCase() === 'pdf';
  const filePath = tailored ? (wantsPdf ? tailored.pdf_path : tailored.docx_path) : '';
  if (!filePath || !fs.existsSync(filePath)) {
    return sendJSON(res, {
      status: 'error', code: 'RESUME_DRAFT_FILE_NOT_FOUND',
      message: wantsPdf
        ? 'No exported PDF exists for this job yet. Generate the tailored resume first.'
        : 'No exported resume file exists for this job yet. Generate the tailored resume first.'
    }, 404);
  }
  const fileName = path.basename(filePath);
  res.writeHead(200, {
    'Content-Type': wantsPdf
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
    'Cache-Control': 'no-store'
  });
  res.end(fs.readFileSync(filePath));
}

const RESUME_EXPORT_DIR = path.join(DOCUMENTS_DIR, 'resume_drafts');

function sha256Of(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

// Exports the stored draft to real files: an editable DOCX always, a PDF when
// a local Chromium is available. Files are namespaced by job and draft so two
// jobs can never receive each other's resume.
async function handleExportResumeDraft(req, res, jobId) {
  let body = {};
  try { body = await readRequestBody(req); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_EXPORT_REQUEST', message: error.message }, 400); }

  const draft = readResumeDraft(jobId);
  if (!draft) {
    return sendJSON(res, {
      status: 'blocked', code: 'RESUME_DRAFT_NOT_FOUND',
      message: 'Generate a tailored resume for this job before exporting it.'
    }, 409);
  }

  const formats = Array.isArray(body.formats) && body.formats.length
    ? body.formats.filter(format => ['docx', 'pdf'].includes(format))
    : ['docx', 'pdf'];

  let model = draftRenderModel(draft);
  // Header language follows the CONTENT (classic_en for English drafts,
  // classic_cn for Chinese) — and the same titles feed BOTH the DOCX and the
  // PDF so the two files can never diverge.
  const renderTemplateName = draft.render_template || detectResumeTemplateForModel(model);
  if (['classic_cn', 'default'].includes(renderTemplateName)) {
    model = {
      ...model,
      sections: (model.sections || []).map(section => ({
        ...section,
        title: CLASSIC_CN_TITLES[section.key] || section.title
      }))
    };
  }
  if (!model.name) {
    // A missing name is a PROFILE gap, not a server failure: tell the user
    // exactly what to fill in and where, in the product's language.
    return sendJSON(res, {
      status: 'blocked', code: 'PROFILE_NAME_REQUIRED',
      message: '简历缺少姓名，无法导出。请到「我的资料 → 基本资料」填写姓名后重新生成。'
    }, 409);
  }

  const safeJob = String(jobId).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const exportDir = path.join(RESUME_EXPORT_DIR, safeJob);
  fs.mkdirSync(exportDir, { recursive: true });
  const baseName = `${draft.draft_id}`;

  const files = { exported_at: new Date().toISOString() };
  const verified = {};

  // DOCX — pure JS, always available. Verified by extracting its text back
  // through the same reader used for uploaded resumes.
  const docxBuffer = buildResumeDocx(model);
  const docxPath = path.join(exportDir, `${baseName}.docx`);
  fs.writeFileSync(docxPath, docxBuffer);
  files.docx = path.relative(PROJECT_ROOT, docxPath);
  files.docx_sha256 = sha256Of(docxBuffer);
  try {
    const roundTrip = extractDocxText(docxBuffer);
    verified.docx_text_ok = roundTrip.text.includes(model.name);
  } catch {
    verified.docx_text_ok = false;
  }

  // PDF — real Chromium print. Honest degradation when no browser exists:
  // the DOCX is complete on its own and the response says exactly why the PDF
  // is missing.
  let pdf = { status: 'not_requested' };
  if (formats.includes('pdf')) {
    const browserExecutable = detectBrowserAgentExecutable();
    if (!browserExecutable) {
      pdf = { status: 'browser_unavailable', message: 'Install Chrome or Edge to export a PDF; the DOCX is complete without it.' };
    } else {
      try {
        const { chromium } = await import('playwright-core');
        const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
        try {
          const page = await browser.newPage();
          await page.setContent(resumeTemplate(renderTemplateName).html(model), { waitUntil: 'load', timeout: 30_000 });
          const pdfBuffer = await page.pdf({
            format: 'A4',
            margin: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' },
            printBackground: true
          });
          const pdfPath = path.join(exportDir, `${baseName}.pdf`);
          fs.writeFileSync(pdfPath, pdfBuffer);
          files.pdf = path.relative(PROJECT_ROOT, pdfPath);
          files.pdf_sha256 = sha256Of(pdfBuffer);
          try {
            const extracted = await extractPdfTextRobust(pdfBuffer);
            verified.pdf_text_ok = String(extracted.text || '').includes(model.name);
          } catch {
            verified.pdf_text_ok = false;
          }
          pdf = { status: 'ok' };
        } finally {
          await browser.close().catch(() => {});
        }
      } catch (error) {
        pdf = { status: 'pdf_generation_failed', message: String(error?.message || error).slice(0, 200) };
      }
    }
  }

  // Completeness check against the active profile: a draft that dropped
  // experience/education/project/skill entries still exports, but the result
  // carries the warning and the UI says "内容不完整" instead of pretending.
  let coverage = null;
  try {
    const coverageStore = readCareerBrainStore();
    const activeCoverageProfile = coverageStore.profiles.find(item => item.id === coverageStore.active_profile_id) || null;
    if (activeCoverageProfile) coverage = verifyDraftCoverage(draft, activeCoverageProfile);
  } catch {
    coverage = null;
  }

  // Bind the files to the draft so every consumer resolves the same paths.
  const updatedDraft = { ...draft, files: { ...(draft.files || {}), ...files }, coverage };
  writePrivateJSON(resumeDraftPath(jobId), updatedDraft);

  return sendJSON(res, {
    status: 'ok',
    job_id: String(jobId),
    draft_id: draft.draft_id,
    files,
    pdf,
    verified,
    coverage,
    safety: { resume_uploaded: false, application_submitted: false }
  });
}

async function handleGenerateResumeDraft(req, res, jobId) {
  let body = {};
  try { body = await readRequestBody(req); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_DRAFT_REQUEST', message: error.message }, 400); }

  const job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId));
  if (!job) return sendJSON(res, { status: 'error', code: 'JOB_NOT_FOUND', message: 'Job not found' }, 404);

  const store = readCareerBrainStore();
  const profile = store.profiles.find(item => item.id === store.active_profile_id) || null;
  if (!profile || profile.user_approved !== true) {
    return sendJSON(res, {
      status: 'blocked', code: 'PROFILE_APPROVAL_REQUIRED',
      message: 'Review and approve your profile before generating a tailored resume.'
    }, 409);
  }

  const deterministic = buildDeterministicDraft({ profile, job });
  const grounding = validateDraftGrounding(deterministic, profile);
  if (!grounding.ok) {
    // Should be impossible by construction; failing closed beats persisting an
    // ungrounded document.
    return sendJSON(res, {
      status: 'error', code: 'DRAFT_GROUNDING_FAILED',
      message: 'The draft could not be verified against your confirmed profile.',
      violations: grounding.violations.slice(0, 10)
    }, 500);
  }

  const provider = configuredAIProvider();
  const aiEnabled = provider.config.enabled === true;
  const useAI = body.use_ai === undefined ? aiEnabled : body.use_ai === true;

  let draft = deterministic;
  let ai = { status: aiEnabled ? 'not_requested' : 'provider_disabled' };
  if (useAI && aiEnabled) {
    // Grounding rejections and off-target summaries surface AFTER the
    // provider call, so the schema layer never retries them. One resample
    // usually lands — without it, every rejection silently shipped the
    // deterministic draft and the user saw "sometimes the summary ignores
    // the job".
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await provider.structuredTask({
          task: 'resume_tailoring',
          input: aiTailoringInput({ profile, job }),
          schema: validateResumeTailoringOutput,
          fallback: null
        });
        recordAIUsage('resume_tailoring', result);
        if (result.status === 'ok' && result.model_used === true && result.value) {
          const merged = mergeAiTailoring(deterministic, result.value, profile, { job });
          draft = merged.draft;
          ai = { ...merged.ai, attempts: attempt };
          if (merged.ai.status === 'ok') break;
        } else {
          ai = { status: 'fallback_after_error', reason: result.status };
          break;
        }
      } catch (error) {
        // AI being unreachable never blocks the draft — the deterministic
        // version is complete on its own.
        ai = { status: 'fallback_after_error', reason: error?.category || 'provider_error' };
        break;
      }
    }
  } else if (useAI && !aiEnabled) {
    ai = { status: 'provider_disabled' };
  }

  // The deterministic reviewer: keyword coverage over the FINAL draft (post
  // AI merge), plus every line the budget cut. Genuine gaps stay visible and
  // are never written into the draft.
  const review = {
    ...buildKeywordCoverage({ profile, job, draft }),
    cut_lines: draft.cut_lines || []
  };

  const document = {
    schema_version: '1.0',
    draft_id: `draft_${Date.now().toString(36)}`,
    job_id: String(jobId),
    job_title: String(job.title || ''),
    company: String(job.company || ''),
    profile_id: profile.id,
    profile_version: profile.version,
    generated_at: new Date().toISOString(),
    ai,
    review,
    blocks: draft.blocks,
    provenance_complete: true
  };
  fs.mkdirSync(RESUME_DRAFTS_DIR, { recursive: true });
  writePrivateJSON(resumeDraftPath(jobId), document);
  return sendJSON(res, { status: 'ok', draft: document });
}

// --- Cover letters ---------------------------------------------------------
// Same lifecycle and the same honesty rules as resume drafts: generated only
// when the user asks, deterministic without AI, AI contributions rejected in
// full on any ungrounded line.

const COVER_LETTERS_DIR = path.join(DATA_DIR, 'cover_letters');

function coverLetterPath(jobId) {
  const safe = String(jobId).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(COVER_LETTERS_DIR, `${safe}.json`);
}

async function handleGenerateCoverLetter(req, res, jobId) {
  let body = {};
  try { body = await readRequestBody(req); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_LETTER_REQUEST', message: error.message }, 400); }

  const job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId));
  if (!job) return sendJSON(res, { status: 'error', code: 'JOB_NOT_FOUND', message: 'Job not found' }, 404);

  const store = readCareerBrainStore();
  const profile = store.profiles.find(item => item.id === store.active_profile_id) || null;
  if (!profile || profile.user_approved !== true) {
    return sendJSON(res, {
      status: 'blocked', code: 'PROFILE_APPROVAL_REQUIRED',
      message: 'Review and approve your profile before generating a cover letter.'
    }, 409);
  }

  const deterministic = buildDeterministicCoverLetter({ profile, job });
  const baseline = validateCoverLetterGrounding(deterministic, profile, job);
  if (!baseline.ok) {
    return sendJSON(res, {
      status: 'error', code: 'LETTER_GROUNDING_FAILED',
      message: 'The letter could not be verified against your confirmed profile.',
      violations: baseline.violations.slice(0, 10)
    }, 500);
  }

  const provider = configuredAIProvider();
  const aiEnabled = provider.config.enabled === true;
  const useAI = body.use_ai === undefined ? aiEnabled : body.use_ai === true;

  let letter = deterministic;
  let ai = { status: aiEnabled ? 'not_requested' : 'provider_disabled' };
  // A sparse profile cannot yield a grounded 90-word AI body no matter how
  // many times the model tries — every attempt fails schema validation and
  // the user stares at "generating…" for minutes before the SAME
  // deterministic letter appears. Skip straight to it.
  const aiLetterInput = aiCoverLetterInput({ profile, job, letter: deterministic });
  const factWordCount = aiLetterInput.facts
    .reduce((total, fact) => total + String(fact.text || '').split(/\s+/).filter(Boolean).length, 0);
  if (useAI && aiEnabled && factWordCount < 120) {
    ai = {
      status: 'skipped_sparse_profile',
      fact_words: factWordCount,
      reason: 'The profile does not carry enough confirmed facts for a grounded AI letter; the deterministic letter stands.'
    };
  } else if (useAI && aiEnabled) {
    // Grounding rejections surface AFTER the provider call, so the schema
    // layer never retries them. One extra sample is cheap and usually lands:
    // typical rejection causes are a single expanded abbreviation or an
    // uncited project name, which a resample avoids.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await provider.structuredTask({
          task: 'cover_letter_generation',
          input: aiLetterInput,
          schema: validateCoverLetterOutput,
          fallback: null
        });
        recordAIUsage('cover_letter_generation', result);
        if (result.status === 'ok' && result.model_used === true && result.value) {
          const merged = mergeAiCoverLetter(deterministic, result.value, profile, job);
          letter = merged.letter;
          ai = { ...merged.ai, attempts: attempt };
          if (merged.ai.status === 'ok') break;
        } else {
          ai = { status: 'fallback_after_error', reason: result.status };
          break;
        }
      } catch (error) {
        ai = { status: 'fallback_after_error', reason: error?.category || 'provider_error' };
        break;
      }
    }
  } else if (useAI && !aiEnabled) {
    ai = { status: 'provider_disabled' };
  }

  const document = {
    schema_version: '1.0',
    letter_id: `letter_${Date.now().toString(36)}`,
    job_id: String(jobId),
    job_title: String(job.title || ''),
    company: String(job.company || ''),
    profile_id: profile.id,
    profile_version: profile.version,
    generated_at: new Date().toISOString(),
    ai,
    paragraphs: letter.paragraphs,
    strengths_used: letter.strengths_used,
    honest_gap: letter.honest_gap,
    provenance_complete: true
  };
  fs.mkdirSync(COVER_LETTERS_DIR, { recursive: true });
  writePrivateJSON(coverLetterPath(jobId), document);
  return sendJSON(res, { status: 'ok', letter: document });
}

function handleGetCoverLetter(res, jobId) {
  const filePath = coverLetterPath(jobId);
  if (!fs.existsSync(filePath)) {
    return sendJSON(res, {
      status: 'error', code: 'COVER_LETTER_NOT_FOUND',
      message: 'No cover letter has been generated for this job yet.'
    }, 404);
  }
  return sendJSON(res, { status: 'ok', letter: readJSON(filePath, null) });
}

function handleDeleteCoverLetter(res, jobId) {
  const filePath = coverLetterPath(jobId);
  if (!fs.existsSync(filePath)) {
    return sendJSON(res, { status: 'error', code: 'COVER_LETTER_NOT_FOUND', message: 'No letter to delete.' }, 404);
  }
  fs.rmSync(filePath, { force: true });
  return sendJSON(res, { status: 'ok', deleted: true, job_id: String(jobId) });
}

function handleGetResumeDraft(res, jobId) {
  const draft = readResumeDraft(jobId);
  if (!draft) {
    return sendJSON(res, {
      status: 'error', code: 'RESUME_DRAFT_NOT_FOUND',
      message: 'No tailored resume has been generated for this job yet.'
    }, 404);
  }
  return sendJSON(res, { status: 'ok', draft });
}

function handleDeleteResumeDraft(res, jobId) {
  const filePath = resumeDraftPath(jobId);
  if (!fs.existsSync(filePath)) {
    return sendJSON(res, { status: 'error', code: 'RESUME_DRAFT_NOT_FOUND', message: 'No draft to delete.' }, 404);
  }
  fs.rmSync(filePath, { force: true });
  return sendJSON(res, { status: 'ok', deleted: true, job_id: String(jobId) });
}

// Sections stored as objects: a patch merges field-by-field, so the UI can send
// only what changed.
const APPLICATION_PROFILE_PATCH_SECTIONS = Object.freeze({
  identity: new Set([
    'full_name', 'first_name', 'last_name', 'preferred_name', 'chinese_name', 'english_name',
    'email', 'phone', 'current_location', 'city', 'state_or_province', 'country', 'links'
  ]),
  job_preferences: new Set([
    'countries', 'cities', 'remote', 'salary', 'industries', 'blocked_industries',
    'relocation_ok', 'work_authorization', 'sponsorship',
    'earliest_start_date', 'notice_period', 'current_company'
  ]),
  skills: new Set(['programming', 'ai_tools', 'frameworks', 'cloud', 'data', 'business'])
});

// Sections stored as ordered lists. A patch replaces the whole list: reordering
// and removing entries are ordinary edits, and a merge-by-index would make both
// impossible to express. normalizeCareerProfile sanitizes each item's shape.
const APPLICATION_PROFILE_LIST_SECTIONS = Object.freeze(new Set([
  'education', 'experience', 'projects', 'certifications', 'languages', 'interview_stories',
  // Target roles / career direction — the deterministic resume summary's
  // "Target role: …" line and the search planner's first-priority role
  // directions both read from here.
  'career_goals'
]));

async function handlePutApplicationProfile(req, res) {
  let body = {};
  try { body = await readRequestBody(req); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_APPLICATION_PROFILE_PATCH', message: error.message }, 400); }
  const store = readCareerBrainStore();
  const activeProfile = store.profiles.find(profile => profile.id === store.active_profile_id) || null;
  if (!activeProfile) {
    return sendJSON(res, {
      status: 'blocked', code: 'APPROVED_PROFILE_MISSING',
      message: 'Create a Career Profile before editing the Application Profile.'
    }, 409);
  }
  const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
  const changes = {};
  for (const [section, allowedKeys] of Object.entries(APPLICATION_PROFILE_PATCH_SECTIONS)) {
    const sectionPatch = patch[section];
    if (!sectionPatch || typeof sectionPatch !== 'object') continue;
    const sanitized = {};
    for (const [key, value] of Object.entries(sectionPatch)) {
      if (allowedKeys.has(key)) sanitized[key] = value;
    }
    if (Object.keys(sanitized).length) {
      // The stored current_location is materialized from its parts; when a
      // part changes without an explicit current_location, drop the stale
      // composite so normalization recomposes it.
      if (section === 'identity'
        && !Object.hasOwn(sanitized, 'current_location')
        && ['city', 'state_or_province', 'country'].some(key => Object.hasOwn(sanitized, key))) {
        sanitized.current_location = '';
      }
      changes[section] = { ...activeProfile[section], ...sanitized };
    }
  }
  for (const section of APPLICATION_PROFILE_LIST_SECTIONS) {
    if (!Array.isArray(patch[section])) continue;
    changes[section] = patch[section];
  }
  // The contract promises `approve:true, confirmed:true` re-approves. With no
  // edits that means approving the CURRENT version as-is (the "confirm my
  // profile" action) — found by the Quick Apply UI, which needs exactly that.
  if (!Object.keys(changes).length && body.approve === true && body.confirmed === true) {
    let approvedResult;
    try {
      approvedResult = approveCareerProfile(store, { profileId: activeProfile.id, confirmed: true, now: new Date().toISOString() });
    } catch (error) {
      return sendJSON(res, {
        status: 'error', code: error?.code || 'APPLICATION_PROFILE_APPROVE_FAILED',
        message: error?.message || 'The profile could not be approved.'
      }, 400);
    }
    const approveBackup = backupFile(CAREER_BRAIN_PATH);
    writeCareerBrainStore(approvedResult.store);
    return sendJSON(res, { status: 'ok', backup: approveBackup, ...applicationProfileViewSnapshot() });
  }
  if (!Object.keys(changes).length) {
    return sendJSON(res, {
      status: 'error', code: 'EMPTY_APPLICATION_PROFILE_PATCH',
      message: 'The patch must change at least one profile section.',
      editable_sections: [
        ...Object.keys(APPLICATION_PROFILE_PATCH_SECTIONS),
        ...APPLICATION_PROFILE_LIST_SECTIONS
      ]
    }, 400);
  }
  const now = new Date().toISOString();
  let result;
  try {
    result = saveCareerProfileVersion(store, { profileId: activeProfile.id, changes, now });
    if (body.approve === true) {
      if (body.confirmed !== true) {
        const error = new Error('confirmed=true is required to re-approve the profile after editing.');
        error.code = 'CAREER_PROFILE_CONFIRMATION_REQUIRED';
        throw error;
      }
      result = approveCareerProfile(result.store, { profileId: result.profile.id, confirmed: true, now });
    }
  } catch (error) {
    const conflict = error?.code === 'CAREER_PROFILE_CONFIRMATION_REQUIRED';
    return sendJSON(res, {
      status: conflict ? 'blocked' : 'error',
      code: error?.code || 'APPLICATION_PROFILE_PATCH_FAILED',
      message: error?.message || 'The Application Profile update failed.'
    }, conflict ? 409 : 400);
  }
  const backup = backupFile(CAREER_BRAIN_PATH);
  writeCareerBrainStore(result.store);
  sendJSON(res, { status: 'ok', backup, ...applicationProfileViewSnapshot() });
}

async function handleCareerBrainProfileAction(req, res) {
  let body = {};
  try {
    body = await readRequestBody(req);
  } catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_CAREER_PROFILE_REQUEST', message: error.message }, 400);
  }
  const action = String(body.action || 'create').trim().toLowerCase();
  const store = readCareerBrainStore();
  const now = new Date().toISOString();
  let result;
  try {
    if (action === 'create') {
      result = createCareerProfile(store, { name: body.name, now });
    } else if (action === 'save_version' || action === 'update') {
      result = saveCareerProfileVersion(store, {
        profileId: body.profile_id,
        changes: body.profile || body.changes,
        now
      });
    } else if (action === 'duplicate') {
      result = duplicateCareerProfile(store, { profileId: body.profile_id, name: body.name, now });
    } else if (action === 'approve') {
      result = approveCareerProfile(store, {
        profileId: body.profile_id,
        confirmed: body.confirmed === true,
        now
      });
    } else if (action === 'activate') {
      result = activateCareerProfile(store, { profileId: body.profile_id });
    } else if (action === 'archive') {
      result = archiveCareerProfile(store, {
        profileId: body.profile_id,
        confirmed: body.confirmed === true,
        now
      });
    } else if (action === 'import') {
      if (body.confirmed !== true) {
        const error = new Error('Explicit user confirmation is required to import a Career Profile.');
        error.code = 'CAREER_PROFILE_CONFIRMATION_REQUIRED';
        throw error;
      }
      result = importCareerProfile(store, { profile: body.profile, name: body.name, now });
    } else if (action === 'migrate_legacy') {
      if (body.confirmed !== true) {
        const error = new Error('Explicit user confirmation is required to create a Career Profile from the current Candidate Profile.');
        error.code = 'CAREER_PROFILE_CONFIRMATION_REQUIRED';
        throw error;
      }
      const resumes = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles())).value;
      const activeResume = resumes.items.find(item => item.resume_id === resumes.active_resume_id || item.id === resumes.active_resume_profile_id) || null;
      const candidate = readCandidateIntelligence(activeResume);
      if (!candidate.profile) {
        const error = new Error(candidate.warning || 'The current Candidate Profile is unavailable.');
        error.code = 'CANDIDATE_PROFILE_INVALID';
        throw error;
      }
      result = importCareerProfile(store, {
        profile: careerProfileFromCandidateProfile(candidate.profile, {
          resumeId: activeResume?.resume_id || '',
          name: body.name || activeResume?.name || 'Imported Career Profile',
          now
        }),
        name: body.name,
        now
      });
    } else {
      return sendJSON(res, {
        status: 'error',
        code: 'INVALID_CAREER_PROFILE_ACTION',
        message: 'Career Profile action must be create, save_version, duplicate, approve, activate, archive, import, or migrate_legacy.'
      }, 400);
    }
  } catch (error) {
    const conflict = error?.code === 'CAREER_PROFILE_CONFIRMATION_REQUIRED';
    const missing = error?.code === 'CAREER_PROFILE_NOT_FOUND';
    return sendJSON(res, {
      status: conflict ? 'blocked' : 'error',
      code: error?.code || 'CAREER_PROFILE_ACTION_FAILED',
      message: error?.message || 'Career Profile action failed.'
    }, conflict ? 409 : missing ? 404 : 400);
  }
  const backup = backupFile(CAREER_BRAIN_PATH);
  writeCareerBrainStore(result.store);
  sendJSON(res, {
    status: 'ok',
    action,
    profile: result.profile,
    career_brain: publicCareerBrainSummary(result.store),
    backup,
    safety: {
      local_profile_only: true,
      raw_resume_text_stored: false,
      automatically_approved: false,
      real_site_opened: false,
      final_submit_clicked: false
    }
  });
}

function handleExportCareerProfile(res, profileId) {
  const store = readCareerBrainStore();
  const profile = store.profiles.find(item => item.id === String(profileId || ''));
  if (!profile) return sendJSON(res, { status: 'error', code: 'CAREER_PROFILE_NOT_FOUND', message: 'Career Profile was not found.' }, 404);
  res.setHeader('Content-Disposition', `attachment; filename="career-profile-${profile.id}.json"`);
  sendJSON(res, {
    export_type: 'resume_jobs_career_profile',
    schema_version: '1.0',
    exported_at: new Date().toISOString(),
    profile,
    safety: { contains_personal_data: true, raw_resume_text_included: false }
  });
}

async function handleSaveAIProvider(req, res) {
  let body = {};
  try {
    body = await readRequestBody(req);
    const existing = savedAIProviderSettings() || {};
    const settings = normalizeAIProviderSettings(body.ai_provider || body, { existing });
    writePrivateJSON(AI_PROVIDER_SETTINGS_PATH, settings);
    const publicSettings = publicAIProviderSettings(settings, { env: {} });
    sendJSON(res, {
      status: 'ok',
      ai_provider: publicSettings,
      safety: {
        credential_returned: false,
        network_accessed: false,
        deterministic_scores_changed: false,
        application_state_changed: false
      }
    });
  } catch (error) {
    sendJSON(res, {
      status: 'error',
      code: error?.code || 'AI_PROVIDER_CONFIGURATION_INVALID',
      category: error?.category || 'configuration',
      message: error?.message || 'AI provider configuration is invalid.'
    }, 400);
  }
}

async function handleTestAIProvider(req, res) {
  try {
    const provider = configuredAIProvider();
    if (!provider.config.enabled) {
      return sendJSON(res, {
        status: 'blocked',
        code: 'AI_PROVIDER_DISABLED',
        message: 'Enable and save an AI provider before testing it.',
        ai_provider: configuredAIProviderStatus(),
        safety: { network_accessed: false, credential_returned: false }
      }, 409);
    }
    const health = await provider.healthCheck();
    sendJSON(res, {
      status: 'ok',
      health,
      ai_provider: configuredAIProviderStatus(),
      safety: { network_accessed: health.network_accessed === true, credential_returned: false }
    });
  } catch (error) {
    const category = error instanceof AIProviderError ? error.category : 'unknown';
    sendJSON(res, {
      status: 'error',
      code: error?.code || 'AI_PROVIDER_TEST_FAILED',
      category,
      message: error?.message || 'AI provider health check failed.',
      ai_provider: configuredAIProviderStatus(),
      safety: { credential_returned: false }
    }, 502);
  }
}

async function handleResetLocalData(req, res) {
  let body = {};
  try {
    body = await readRequestBody(req);
  } catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_RESET_REQUEST', message: error.message }, 400);
  }
  if (body.confirmed !== true || String(body.confirmation_text || '') !== RESET_CONFIRMATION_TEXT) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'LOCAL_DATA_RESET_CONFIRMATION_REQUIRED',
      message: `Type ${RESET_CONFIRMATION_TEXT} and confirm before resetting local product data.`
    }, 409);
  }
  if (runningJob) {
    return sendJSON(res, {
      status: 'busy',
      code: 'LOCAL_DATA_RESET_JOB_RUNNING',
      message: `Wait for the current ${runningJob.type} operation to finish before resetting local data.`
    }, 409);
  }
  try {
    const result = resetLocalData();
    sendJSON(res, {
      status: 'ok',
      next_view: 'resume',
      ...result,
      browser_extension_state: 'will_clear_on_next_popup_open',
      safety: {
        real_site_opened: false,
        network_accessed: false,
        application_submitted: false,
        source_files_modified: false
      }
    });
  } catch (error) {
    sendJSON(res, {
      status: 'error',
      code: error.code || 'LOCAL_DATA_RESET_FAILED',
      message: error.message
    }, 500);
  }
}

// Offers the settings screen the provider list plus whatever local model server
// is already running, so the common case (LM Studio on the default port) needs
// no typing. A machine with no local server is normal, not an error.
// Plain-language status for one job, in the vocabulary the product shows the
// user. Internal state names, session ids and package ids stay on this side of
// the boundary; the UI never has to map them itself, so it cannot invent a
// vocabulary of its own the way the original Dashboard did.
const PUBLIC_APPLICATION_STATUS = Object.freeze({
  DISCOVERED: 'found',
  REVIEW_PENDING: 'found',
  SAVED: 'saved',
  REJECTED: 'rejected',
  // A package at rest is a durable fact, not ongoing work: without a live
  // execution session these project as the resumable 'ready_to_open', never
  // as a spinner. publicApplicationStateFor() upgrades them to 'preparing'
  // only while a real session is being set up.
  APPROVED_FOR_PACKAGE: 'ready_to_open',
  PACKAGE_READY: 'ready_to_open',
  FILL_APPROVED: 'ready_to_open',
  EXECUTOR_READY: 'preparing',
  EXECUTING: 'filling',
  NEEDS_REVIEW: 'needs_you',
  READY_FOR_MANUAL_SUBMIT: 'ready_to_submit',
  MANUALLY_SUBMITTED: 'applied',
  SUBMITTED: 'applied',
  RECOVERY_REQUIRED: 'needs_you',
  CANCELLED: 'found',
  SUPERSEDED: 'found',
  MANUAL_ONLY: 'manual_only',
  UNSUPPORTED: 'manual_only'
});

// A challenge the user has to clear personally is its own visible state:
// "waiting for you to verify" is not the same as "needs you to fill fields".
//
// The signal can arrive from either direction, and reading only one of them
// left a challenged page reporting "needs you" with a re-scan item the user
// could never satisfy: the FIRST fill attempt records the challenge on the
// execution attempt, while a later re-scan records it on the scan.
function awaitingVerificationFor(record, session) {
  const scan = session?.latest_review_rescan || record?.latest_review_rescan || null;
  const attempts = Array.isArray(session?.execution_attempts) ? session.execution_attempts : [];
  const latestAttempt = attempts[attempts.length - 1] || null;
  const challengeActive = scan?.challenge_scope === 'active'
    || String(record?.challenge_scope || '') === 'active'
    || (!scan && latestAttempt?.challenge_scope === 'active');
  return Boolean(
    session
    && session.execution_status !== 'READY_FOR_MANUAL_SUBMIT'
    && challengeActive
  );
}

function handleApplyState(res, jobId) {
  const job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId));
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  if (!job && !record.job_id) {
    return sendJSON(res, { status: 'error', code: 'JOB_NOT_FOUND', message: 'Job not found' }, 404);
  }

  const applicationStatus = record.application_status
    ? normalizeApplicationStatus(record.application_status)
    : deriveApplicationStatus({ job: job || {}, override: record });

  const sessionId = String(record.active_session_id || '');
  const session = sessionId ? state.application_execution_sessions[sessionId] : null;
  const liveness = session ? sessionLivenessSnapshot(session) : null;
  const awaitingVerification = awaitingVerificationFor(record, session);
  const projected = publicApplicationStateFor({ applicationStatus, session, liveness, awaitingVerification });

  const checklist = internalChecklistSnapshot(jobId, { state });

  // Newly discovered ordinary questions (ASK_ONCE) the user can answer right
  // in the Assistant. Grouped per question; a radio/checkbox group merges the
  // options of all its members. Sensitive and manual-only items never appear
  // here — they stay in the checklist with their own marks.
  const openQuestions = (() => {
    if (checklist.scan_state !== 'fresh') return [];
    const scan = session?.latest_review_rescan || record.latest_review_rescan || null;
    if (!scan) return [];
    const groups = new Map();
    for (const field of Array.isArray(scan.fields) ? scan.fields : []) {
      if (field.required !== true || field.sensitive === true) continue;
      if (['file', 'hidden', 'password'].includes(field.type)) continue;
      if (field.question_class && field.question_class !== 'ASK_ONCE') continue;
      const key = (['radio', 'checkbox'].includes(field.type)
        ? field.group_key
        : field.normalized_question || field.group_key) || field.field_ref;
      const existing = groups.get(key);
      if (existing) {
        existing.filled = existing.filled || field.filled === true;
        const memberLabel = (field.label || '').trim();
        if (memberLabel && !existing.member_labels.includes(memberLabel)) existing.member_labels.push(memberLabel);
        for (const option of field.options || []) {
          if (!existing.options.some(item => item.value === option.value && item.label === option.label)) {
            existing.options.push(option);
          }
        }
        continue;
      }
      groups.set(key, {
        id: key,
        field_ref: field.field_ref,
        group_label: (field.group_label || '').trim(),
        member_labels: [(field.label || '').trim()].filter(Boolean),
        type: field.type,
        filled: field.filled === true,
        options: [...(field.options || [])]
      });
    }
    return [...groups.values()]
      .filter(group => !group.filled && (group.group_label || group.member_labels.length))
      .slice(0, 6)
      .map(({ filled, member_labels, group_label, ...group }) => ({
        ...group,
        label: group_label
          || (member_labels.length > 1
            ? `Select an option: ${member_labels.slice(0, 4).join(' / ')}${member_labels.length > 4 ? ' …' : ''}`
            : member_labels[0] || '')
      }));
  })();

  sendJSON(res, {
    status: 'ok',
    job_id: String(jobId),
    open_questions: openQuestions,
    title: job?.title || record.title || '',
    company: job?.company || record.company || '',
    apply_url: resolveApplicationPageUrl(job || record) || '',
    // The single word the UI renders. Never a state-machine constant.
    state: projected.state,
    // 'ready_to_open' means: prepared work exists (package / interrupted
    // session) and the user can continue from preflight — nothing is running.
    resumable: projected.resumable,
    stale_reason: projected.stale_reason,
    // Who fills: 'local_browser_agent' (the product's own window) or
    // 'extension' (the Assistant in the user's own browser). The UI adapts
    // its actions — e.g. the open-page link belongs to the extension flow.
    executor: normalizeExecutorMode(session?.executor_type || record.selected_executor_type || record.executor || ''),
    things_left: checklist.things_left,
    checklist: checklist.items,
    // Whether the checklist reflects a fresh scan of the live page. The UI
    // triggers one real re-scan when this is missing/stale and the page is
    // open, so the list always names actual fields, never a stale guess.
    scan_state: checklist.scan_state,
    can_mark_submitted: checklist.can_mark_submitted,
    can_continue_after_verification: awaitingVerification && liveness?.connection_live === true,
    tailored_resume: (() => {
      const tailored = tailoredResumeFor(jobId);
      return tailored
        ? { available: true, file_name: tailored.file_name, has_pdf: Boolean(tailored.pdf_path), stale_profile: tailored.stale_profile, content_complete: tailored.content_complete }
        : { available: false };
    })(),
    browser_open: liveness?.connection_live === true,
    // Live watch telemetry (additive): while the agent window is open the
    // page is re-scanned automatically after the user's edits settle, so the
    // UI can say "正在监测" instead of looking parked — and can surface that
    // the page left the application form (a submit success screen, a
    // redirect) so the user is prompted to declare what happened.
    monitoring: (() => {
      if (liveness?.connection_live !== true) return { active: false, page_state: '' };
      const agentStatus = session?.browser_agent?.status_path
        ? readJSON(session.browser_agent.status_path, {})
        : {};
      return {
        active: ['PAUSED_FOR_USER_REVIEW', 'REVIEW_RESCANNED', 'VERIFICATION_REQUIRED'].includes(String(agentStatus.status || '')),
        page_state: String(agentStatus.status || '') === 'PAGE_NAVIGATED' ? 'left_page' : 'on_page',
        last_scan_at: String(agentStatus.review_rescan?.scanned_at || agentStatus.updated_at || ''),
      };
    })(),
    needs_attention_reason: awaitingVerification
      ? 'verification_required'
      : (checklist.things_left > 0 ? 'checklist' : ''),
    safety: { resume_uploaded: false, application_submitted: false }
  });
}

// The one state projection every surface reads. apply-state, the /api/jobs
// rows and the applications page all resolve a job's public word through this
// function, so no two pages can disagree about whether something is running.
//
// 'preparing' / 'filling' are transient claims: they require an execution
// session that is genuinely alive (live connection, or updated within
// SESSION_STALE_TTL_MS). A package at rest, a session that was created but
// never started, or an interrupted execution all project as the resumable
// 'ready_to_open' — the user can continue, but nothing is spinning.
function publicApplicationStateFor({ applicationStatus, session = null, liveness = null, awaitingVerification = false, now = Date.now() }) {
  if (awaitingVerification) return { state: 'awaiting_verification', resumable: false, stale_reason: '' };
  let word = PUBLIC_APPLICATION_STATUS[applicationStatus] || 'found';
  let staleReason = '';
  const executionStatus = String(session?.execution_status || '');
  const activeExecution = ['EXECUTOR_READY', 'EXTENSION_CONNECTED', 'FIELDS_DETECTED', 'FILLING'].includes(executionStatus);
  const sessionUpdatedMs = Date.parse(session?.updated_at || session?.created_at || '');
  const sessionRecent = Number.isFinite(sessionUpdatedMs) && now - sessionUpdatedMs <= SESSION_STALE_TTL_MS;
  const sessionLive = liveness?.connection_live === true;
  if (word === 'preparing' || word === 'filling') {
    if (!session || executionStatus === 'SESSION_CREATED') {
      // EXECUTOR_READY/EXECUTING recorded on the job but no running session:
      // the preparation was interrupted (crash, restart, never launched).
      word = 'ready_to_open';
      staleReason = session ? '' : 'no_execution_session';
    } else if (!sessionLive && !sessionRecent) {
      word = 'ready_to_open';
      staleReason = 'execution_interrupted';
    }
  } else if (word === 'ready_to_open' && activeExecution && (sessionLive || sessionRecent)) {
    // FILL_APPROVED whose session is already being set up IS active work.
    word = 'preparing';
  }
  return { state: word, resumable: word === 'ready_to_open', stale_reason: staleReason };
}

async function handleDetectLocalAI(res) {
  const detected = await detectLocalAIProviders();
  sendJSON(res, {
    status: 'ok',
    presets: AI_PROVIDER_PRESETS,
    detected,
    detected_count: detected.length,
    safety: { credential_returned: false, network_accessed: false, loopback_only: true }
  });
}

// Lightweight inventory sweep for the 岗位 page: removes SEARCHED jobs and the
// search-run history so the user can start a fresh hunt — while everything
// they touched by hand survives (applications in any state, saved,
// shortlisted). Profile, resumes, answers, plans, settings are never touched;
// the two Data-and-privacy buttons keep their own, broader semantics.
async function handleClearSearchRecords(req, res) {
  let body = {};
  try {
    body = await readRequestBody(req);
  } catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_CLEAR_REQUEST', message: error.message }, 400);
  }
  if (body.confirmed !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'CLEAR_SEARCH_RECORDS_CONFIRMATION_REQUIRED',
      message: 'confirmed=true is required before clearing search records.'
    }, 409);
  }
  const jobs = readJSON(dataPath('job_leads.json'), []);
  const state = getDashboardState();
  const overrides = state.application_status_overrides || {};
  // Authoritative keep signals only: an application record exists for the job
  // (applying, applied, saved, rejected — anything the user DECIDED), or the
  // job record itself carries a user flag. An untouched searched job has
  // neither and is swept.
  const kept = (Array.isArray(jobs) ? jobs : []).filter(job => {
    if (overrides[String(job.job_id)]) return true;
    return job.saved === true || job.shortlisted === true || job.ignored_forever === true;
  });
  const removed = (Array.isArray(jobs) ? jobs : []).length - kept.length;
  backupFile(dataPath('job_leads.json'));
  writeJSON(dataPath('job_leads.json'), kept);
  const runsPath = dataPath('search_runs.json');
  if (fs.existsSync(runsPath)) {
    backupFile(runsPath);
    writeJSON(runsPath, []);
  }
  // The in-memory last run drives the 本轮新增 tab; a cleared inventory must
  // not keep pointing at it.
  globalSearchRun = null;
  return sendJSON(res, {
    status: 'ok',
    removed_jobs: removed,
    kept_jobs: kept.length,
    kept_reason: 'applications, saved, shortlisted and hidden jobs are preserved',
    safety: { profile_touched: false, resumes_touched: false, answers_touched: false }
  });
}

async function handleClearJobMaterials(req, res) {
  let body = {};
  try {
    body = await readRequestBody(req);
  } catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_CLEAR_REQUEST', message: error.message }, 400);
  }
  if (body.confirmed !== true
    || String(body.confirmation_text || '') !== CLEAR_JOB_MATERIALS_CONFIRMATION_TEXT) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'CLEAR_JOB_MATERIALS_CONFIRMATION_REQUIRED',
      message: `Type ${CLEAR_JOB_MATERIALS_CONFIRMATION_TEXT} and confirm before clearing your job-seeking materials.`,
      deletes: [
        'online profile', 'uploaded resumes', 'tailored resumes and cover letters',
        'saved answers', 'learned form-field rules', 'prepared application files'
      ],
      keeps: ['application history', 'job decisions', 'discovered jobs', 'audit events']
    }, 409);
  }
  if (runningJob) {
    return sendJSON(res, {
      status: 'busy',
      code: 'CLEAR_JOB_MATERIALS_JOB_RUNNING',
      message: `Wait for the current ${runningJob.type} operation to finish before clearing your materials.`
    }, 409);
  }
  try {
    const result = clearJobMaterials();
    sendJSON(res, {
      status: 'ok',
      scope: 'job_materials_only',
      ...result,
      browser_extension_state: 'will_clear_on_next_popup_open',
      safety: {
        real_site_opened: false,
        network_accessed: false,
        application_submitted: false,
        source_files_modified: false
      }
    });
  } catch (error) {
    sendJSON(res, {
      status: 'error',
      code: error.code || 'CLEAR_JOB_MATERIALS_FAILED',
      message: error.message
    }, 500);
  }
}

function handleExtensionLocalState(req, res) {
  const extensionId = extensionIdFromOrigin(req);
  if (!extensionId) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'EXTENSION_ORIGIN_REQUIRED',
      message: 'This private localhost state endpoint is available only to the Resume Jobs browser extension.'
    }, 403);
  }
  const existing = extensionConnections.get(extensionId) || {};
  extensionConnections.set(extensionId, {
    ...existing,
    extension_id: extensionId,
    last_seen: new Date().toISOString(),
    content_script_connected: existing.content_script_connected === true,
    application_run_active: existing.application_run_active === true,
    active_handoff: existing.active_handoff === true
  });
  const state = getDashboardState();
  sendJSON(res, {
    status: 'ok',
    reset_epoch: String(state.local_reset_epoch || ''),
    reset_at: String(state.local_reset_at || ''),
    safety: { personal_data_included: false }
  });
}

function handleProductWorkflowState(res) {
  const search = normalizeSearchPreferences(readJSON(dataPath('search_preferences.json'), defaultSearchPreferences())).value;
  const resumes = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles())).value;
  const activeResume = resumes.items.find(item =>
    item.resume_id === resumes.active_resume_id || item.id === resumes.active_resume_profile_id
  ) || null;
  const candidate = readCandidateIntelligence(activeResume);
  const careerBrain = readCareerBrainStore();
  const activeCareerProfile = careerBrain.profiles.find(profile => profile.id === careerBrain.active_profile_id) || null;
  sendJSON(res, buildWorkflowState({
    searchPreferences: search,
    resumeProfiles: resumes,
    resumeIntelligence: candidate.intelligence,
    careerProfile: activeCareerProfile,
    searchRuns: readJSON(dataPath('search_runs.json'), []),
    jobs: getJobsWithOverlay()
  }));
}

async function handleConfirmCandidateFacts(req, res) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  if (body.confirmed !== true) {
    return sendJSON(res, {
      status: 'error',
      code: 'EXPLICIT_CONFIRMATION_REQUIRED',
      message: 'Set confirmed=true only after reviewing the current candidate facts.'
    }, 400);
  }
  const resumes = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles()));
  const activeResume = resumes.value.items.find(item =>
    item.resume_id === resumes.value.active_resume_id || item.id === resumes.value.active_resume_profile_id
  ) || null;
  try {
    verifiedResumeLibraryFile(activeResume);
  } catch (error) {
    if (sendLocalAnalysisError(res, error)) return;
    throw error;
  }
  const candidate = readCandidateIntelligence(activeResume);
  if (!candidate.profile || !candidate.profilePath) {
    return sendJSON(res, {
      status: 'error',
      code: 'CANDIDATE_PROFILE_MISSING',
      message: candidate.warning || 'Candidate profile file is missing.'
    }, 404);
  }
  let confirmed;
  try {
    confirmed = confirmCandidateProfileSnapshot({
      profile: candidate.profile,
      selectedResume: activeResume,
      expectedSnapshotToken: String(body.snapshot_token || ''),
      now: new Date().toISOString()
    });
  } catch (error) {
    return sendJSON(res, {
      status: 'error',
      code: error.code || 'CANDIDATE_FACT_CONFIRMATION_FAILED',
      message: error.message
    }, error.code === 'STALE_FACT_SNAPSHOT' ? 409 : 400);
  }
  const profileBackup = backupFile(candidate.profilePath);
  const resumeProfilesPath = dataPath('resume_profiles.json');
  const resumeProfilesBackup = backupFile(resumeProfilesPath);
  const approvedResumeProfiles = normalizeResumeProfiles({
    active_resume_profile_id: resumes.value.active_resume_profile_id,
    items: resumes.value.items.map(item => item.resume_id === activeResume.resume_id
      ? {
          ...item,
          approved_at: item.approved_at || confirmed.confirmed_at,
          allow_resume_attach: false,
          allow_final_submit: false
        }
      : item)
  }).value;
  writeJSON(resumeProfilesPath, persistedResumeProfiles(approvedResumeProfiles));
  writeJSON(candidate.profilePath, confirmed.profile);
  sendJSON(res, {
    status: 'ok',
    confirmed_at: confirmed.confirmed_at,
    resume_intelligence: confirmed.resume_intelligence,
    candidate_profile: {
      source: candidateProfileSourceLabel(candidate.profilePath),
      available: true,
      can_confirm_snapshot: true
    },
    backup: profileBackup,
    resume_profiles_backup: resumeProfilesBackup,
    approved_resume: approvedResumeProfiles.items.find(item => item.resume_id === activeResume.resume_id) || null,
    safety: {
      ...confirmed.safety,
      current_resume_version_approved_for_package: true,
      resume_attached: false,
      real_site_opened: false,
      resume_uploaded: false,
      final_submit_clicked: false
    }
  });
}

async function handleCandidateFactMutation(req, res) {
  let body = {};
  try {
    body = await readRequestBody(req);
  } catch (err) {
    return sendJSON(res, { status: 'error', code: 'INVALID_CANDIDATE_FACT_CHANGE', message: err.message }, 400);
  }
  const action = String(body.action || 'edit').trim().toLowerCase();
  if (['delete', 'approve', 'reject'].includes(action) && body.confirmed !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'CANDIDATE_FACT_CONFIRMATION_REQUIRED',
      message: `confirmed=true is required for Candidate Profile fact ${action}.`
    }, 409);
  }
  const resumes = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles()));
  const activeResume = resumes.value.items.find(item =>
    item.resume_id === resumes.value.active_resume_id || item.id === resumes.value.active_resume_profile_id
  ) || null;
  if (!activeResume || activeResume.resume_file_status !== 'exists') {
    return sendJSON(res, {
      status: 'blocked',
      code: 'ACTIVE_RESUME_REQUIRED',
      message: 'Upload and select a valid local Resume Version before editing Profile facts.'
    }, 409);
  }
  const candidate = readCandidateIntelligence(activeResume);
  if (!candidate.profilePath) {
    return sendJSON(res, {
      status: 'error',
      code: 'CANDIDATE_PROFILE_PATH_MISSING',
      message: 'A writable local Candidate Profile path is not configured.'
    }, 409);
  }
  let mutation;
  try {
    mutation = mutateCandidateFact({
      profile: candidate.profileExists === false
        ? defaultCandidateProfile()
        : (candidate.profile || defaultCandidateProfile()),
      selectedResume: activeResume,
      factKey: body.fact_key,
      action,
      value: body.value,
      now: new Date().toISOString()
    });
  } catch (error) {
    return sendJSON(res, {
      status: 'error',
      code: error.code || 'CANDIDATE_FACT_CHANGE_FAILED',
      message: error.message
    }, ['CANDIDATE_FACT_NOT_FOUND'].includes(error.code) ? 404 : 400);
  }
  const backup = backupFile(candidate.profilePath);
  writeJSON(candidate.profilePath, mutation.profile);
  sendJSON(res, {
    status: 'ok',
    action: mutation.action,
    fact_key: mutation.fact_key,
    updated_at: mutation.updated_at,
    resume_intelligence: mutation.resume_intelligence,
    backup,
    safety: mutation.safety
  });
}

async function handleCandidateProfileVersion(req, res) {
  let body = {};
  try {
    body = await readRequestBody(req);
  } catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_PROFILE_VERSION_REQUEST', message: error.message }, 400);
  }
  const action = String(body.action || 'create').trim().toLowerCase();
  if (['activate', 'delete'].includes(action) && body.confirmed !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'CANDIDATE_PROFILE_VERSION_CONFIRMATION_REQUIRED',
      message: `confirmed=true is required to ${action} a Candidate Profile version.`
    }, 409);
  }
  const resumes = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles()));
  const activeResume = resumes.value.items.find(item =>
    item.resume_id === resumes.value.active_resume_id || item.id === resumes.value.active_resume_profile_id
  ) || null;
  if (!activeResume || activeResume.resume_file_status !== 'exists') {
    return sendJSON(res, {
      status: 'blocked',
      code: 'ACTIVE_RESUME_REQUIRED',
      message: 'Upload and select a valid local Resume Version before managing Profile versions.'
    }, 409);
  }
  const candidate = readCandidateIntelligence(activeResume);
  if (!candidate.profilePath || !candidate.profile || candidate.profileExists === false) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'CANDIDATE_PROFILE_REQUIRED',
      message: 'Create or edit Candidate Profile facts before saving a Profile version.'
    }, 409);
  }
  let result;
  try {
    if (action === 'create') {
      result = createCandidateProfileVersion({
        profile: candidate.profile,
        selectedResume: activeResume,
        name: body.name,
        now: new Date().toISOString()
      });
    } else if (action === 'activate') {
      result = activateCandidateProfileVersion({
        profile: candidate.profile,
        selectedResume: activeResume,
        versionId: body.version_id,
        now: new Date().toISOString()
      });
    } else if (action === 'delete') {
      result = deleteCandidateProfileVersion({
        profile: candidate.profile,
        versionId: body.version_id
      });
    } else {
      return sendJSON(res, {
        status: 'error',
        code: 'INVALID_CANDIDATE_PROFILE_VERSION_ACTION',
        message: 'Profile version action must be create, activate, or delete.'
      }, 400);
    }
  } catch (error) {
    return sendJSON(res, {
      status: 'error',
      code: error.code || 'CANDIDATE_PROFILE_VERSION_FAILED',
      message: error.message
    }, error.code === 'CANDIDATE_PROFILE_VERSION_NOT_FOUND' ? 404 : 400);
  }
  const backup = backupFile(candidate.profilePath);
  writePrivateJSON(candidate.profilePath, result.profile);
  sendJSON(res, {
    status: 'ok',
    action,
    version: result.version || null,
    deleted_version_id: result.deleted_version_id || '',
    candidate_profile_versions: result.versions,
    resume_intelligence: result.resume_intelligence || buildResumeIntelligence({
      profile: result.profile,
      selectedResume: activeResume
    }),
    backup,
    safety: {
      local_profile_only: true,
      profile_review_required: action === 'activate',
      real_site_opened: false,
      resume_uploaded: false,
      final_submit_clicked: false
    }
  });
}

async function handleSaveSearchPreferences(req, res) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  let normalized;
  try {
    normalized = normalizeSearchPreferences(body.search_preferences || body, { strict: true });
  } catch (err) {
    if (err instanceof SearchPreferencesValidationError) {
      return sendJSON(res, { status: 'error', code: err.code, message: err.message, issues: err.issues }, 400);
    }
    throw err;
  }
  const { value, warnings } = normalized;
  const now = new Date().toISOString();
  value.workflow_meta = {
    ...(value.workflow_meta || {}),
    configured_at: now,
    configured_by: 'user_dashboard',
    configuration_fingerprint: searchConfigurationFingerprint(value)
  };
  const filePath = dataPath('search_preferences.json');
  const backup = backupFile(filePath);
  writeJSON(filePath, value);
  sendJSON(res, { status: 'ok', search_preferences: value, backup, warnings });
}

function persistedJobSearchSources(body = {}) {
  const requested = body.job_search_sources || body;
  const providerInput = Array.isArray(requested.providers)
    ? requested.providers.find(provider => provider?.id === SEARXNG_PROVIDER_ID) || {}
    : requested?.search_backends?.[SEARXNG_PROVIDER_ID] || requested?.searxng_search || {};
  const existing = normalizeJobSearchSources(readJSON(dataPath('job_sources.json'), {}));
  const enabled = providerInput.enabled === true;
  const url = String(providerInput.endpoint ?? providerInput.url ?? '').trim();
  if (enabled || url) validateSearchProviderUrl(url);
  return normalizeJobSearchSources({
    ...existing,
    search_backends: {
      ...existing.search_backends,
      [SEARXNG_PROVIDER_ID]: {
        ...existing.search_backends[SEARXNG_PROVIDER_ID],
        enabled,
        url,
        timeout_ms: providerInput.timeout_ms,
        max_results_per_query: providerInput.max_results_per_query,
        status: enabled ? 'ERROR' : 'DISABLED',
        last_health_check: '',
        last_error: enabled ? 'Connection has not been tested since this configuration changed.' : ''
      }
    }
  });
}

async function handleSaveJobSearchSources(req, res) {
  let body = {};
  try {
    body = await readRequestBody(req);
    const value = persistedJobSearchSources(body);
    const filePath = dataPath('job_sources.json');
    const backup = backupFile(filePath);
    writeJSON(filePath, value);
    sendJSON(res, {
      status: 'ok',
      job_search_sources: publicConfiguredJobSearchSources(value),
      backup
    });
  } catch (error) {
    sendJSON(res, {
      status: 'error',
      code: error.code || 'JOB_SEARCH_SOURCES_INVALID',
      message: error.message
    }, 400);
  }
}

function updateSavedProviderHealth(result) {
  const filePath = dataPath('job_sources.json');
  const sources = normalizeJobSearchSources(readJSON(filePath, {}));
  const current = sources.search_backends[SEARXNG_PROVIDER_ID];
  const next = normalizeJobSearchSources({
    ...sources,
    search_backends: {
      ...sources.search_backends,
      [SEARXNG_PROVIDER_ID]: {
        ...current,
        status: result.status,
        last_health_check: result.last_health_check,
        last_error: result.last_error
      }
    }
  });
  writeJSON(filePath, next);
  return next;
}

async function handleTestJobSearchProvider(req, res) {
  let body = {};
  try {
    body = await readRequestBody(req);
    const saved = normalizeJobSearchSources(readJSON(dataPath('job_sources.json'), {}));
    const input = body.provider || body;
    const provider = {
      ...saved.search_backends[SEARXNG_PROVIDER_ID],
      enabled: input.enabled !== false,
      url: String(
        input.endpoint
        ?? input.url
        ?? saved.search_backends[SEARXNG_PROVIDER_ID].url
        ?? ''
      ).trim(),
      timeout_ms: input.timeout_ms ?? saved.search_backends[SEARXNG_PROVIDER_ID].timeout_ms
    };
    const result = await testSearxngConnection(provider);
    const matchesSavedEndpoint = provider.url === saved.search_backends[SEARXNG_PROVIDER_ID].url;
    const next = matchesSavedEndpoint ? updateSavedProviderHealth(result) : saved;
    sendJSON(res, {
      status: result.status,
      ok: result.ok,
      last_health_check: result.last_health_check,
      last_error: result.last_error,
      result_count: result.result_count,
      saved_health_updated: matchesSavedEndpoint,
      job_search_sources: publicConfiguredJobSearchSources(next),
      safety: {
        query_contains_personal_data: false,
        job_site_opened: false,
        login_attempted: false,
        resume_uploaded: false,
        application_submitted: false
      }
    }, result.ok ? 200 : 503);
  } catch (error) {
    sendJSON(res, {
      status: 'MISCONFIGURED',
      ok: false,
      code: error.code || 'JOB_SEARCH_PROVIDER_TEST_FAILED',
      message: error.message,
      last_error: error.message
    }, 400);
  }
}

async function handleSaveResumeProfiles(req, res) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  const { value, warnings } = normalizeResumeProfiles(body.resume_profiles || body);
  const filePath = dataPath('resume_profiles.json');
  const backup = backupFile(filePath);
  writeJSON(filePath, persistedResumeProfiles(value));
  sendJSON(res, { status: 'ok', resume_profiles: value, backup, warnings });
}

async function handleResumeUpload(req, res) {
  let body = {};
  try {
    body = await readRequestBody(req, { maxBytes: Math.ceil(MAX_RESUME_UPLOAD_BYTES / 3) * 4 + 64 * 1024 });
  } catch (err) {
    return sendJSON(res, { status: 'error', code: 'INVALID_RESUME_UPLOAD', message: err.message }, 400);
  }
  if (body.confirmed_local_copy !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'LOCAL_COPY_CONFIRMATION_REQUIRED',
      message: 'confirmed_local_copy=true is required before copying a resume into the local Resume Library.'
    }, 409);
  }

  let upload;
  try {
    upload = validateResumeUpload(body);
  } catch (err) {
    if (err instanceof ResumeUploadValidationError) {
      return sendJSON(res, { status: 'error', code: err.code, message: err.message }, 400);
    }
    throw err;
  }

  const filePath = dataPath('resume_profiles.json');
  const current = normalizeResumeProfiles(readJSON(filePath, defaultResumeProfiles())).value;
  const duplicate = current.items.find(item => item.content_hash === upload.content_hash);
  if (duplicate) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'DUPLICATE_RESUME_CONTENT',
      message: 'This resume content already exists in the Resume Library.',
      existing_resume_id: duplicate.resume_id
    }, 409);
  }

  const draft = buildUploadedResumeProfile(current, {
    fileName: upload.file_name,
    displayName: body.display_name,
    contentHash: upload.content_hash,
    targetRoles: Array.isArray(body.target_roles) ? body.target_roles : [],
    language: body.language,
    now: new Date().toISOString()
  });
  fs.mkdirSync(RESUME_LIBRARY_DIR, { recursive: true });
  const storedPath = path.join(RESUME_LIBRARY_DIR, `${draft.resume_id}${upload.extension}`);
  const fileReference = portableFileReference(storedPath);
  const resumeProfile = {
    ...draft,
    resume_file_path: fileReference,
    file_reference: fileReference
  };
  const hasActiveResume = current.items.some(item =>
    (item.resume_id === current.active_resume_profile_id || item.id === current.active_resume_profile_id)
    && item.resume_file_status === 'exists'
  );
  const next = normalizeResumeProfiles({
    active_resume_profile_id: body.activate === false && hasActiveResume
      ? current.active_resume_profile_id
      : resumeProfile.resume_id,
    items: [...current.items, resumeProfile]
  }).value;

  const becomesActive = next.active_resume_profile_id === resumeProfile.resume_id;
  const analysisProfilePath = candidateProfilePath(resumeProfile, { allowMissing: true });
  let automaticAnalysis = null;
  let transientResumeText = '';
  let automaticProfileDraft = null;
  let automaticAnalysisError = null;
  let candidateProfileCanPersist = true;
  if (analysisProfilePath) {
    try {
      const profileExists = fs.existsSync(analysisProfilePath);
      let existingProfile = profileExists ? readJSON(analysisProfilePath, null) : defaultCandidateProfile();
      if (!existingProfile || typeof existingProfile !== 'object' || Array.isArray(existingProfile)) {
        candidateProfileCanPersist = false;
        existingProfile = defaultCandidateProfile();
        automaticAnalysisError = {
          code: 'CANDIDATE_PROFILE_INVALID',
          message: 'The legacy Candidate Profile is not valid JSON. It was preserved unchanged; a separate Career Brain draft will still be created from this resume.'
        };
      }
      const existingIntelligence = buildResumeIntelligence({
        profile: existingProfile,
        selectedResume: resumeProfile
      });
      const analyzed = await analyzeResumeDocumentRobust({
        content: upload.content,
        fileName: upload.file_name,
        contentHash: upload.content_hash,
        existingFacts: existingIntelligence.facts
      });
      transientResumeText = String(analyzed.transient_text || '');
      if (becomesActive) {
        const persisted = persistResumeAnalysisDraft({
          profile: existingProfile,
          suggestions: analyzed.suggestions,
          resumeId: resumeProfile.resume_id,
          contentHash: resumeProfile.content_hash,
          analysisSnapshotToken: analyzed.snapshot_token,
          now: new Date().toISOString()
        });
        automaticProfileDraft = persisted.profile;
        automaticAnalysis = {
          ...analyzed,
          suggestions: persisted.prepared_suggestions,
          summary: {
            ...analyzed.summary,
            applicable_suggestion_count: persisted.prepared_suggestions.filter(item => item.can_apply_to_existing_profile).length,
            persisted_fact_count: persisted.applied.length
          },
          persistence: {
            ...analyzed.persistence,
            suggestions_saved: false,
            candidate_facts_saved: persisted.applied.length,
            candidate_profile_modified: persisted.applied.length > 0,
            resume_profile_modified: false
          }
        };
      } else {
        const prepared = prepareResumeSuggestionTargets(existingProfile, analyzed.suggestions);
        automaticAnalysis = {
          ...analyzed,
          suggestions: prepared,
          summary: {
            ...analyzed.summary,
            applicable_suggestion_count: prepared.filter(item => item.can_apply_to_existing_profile).length,
            persisted_fact_count: 0
          }
        };
      }
    } catch (error) {
      automaticAnalysisError = {
        code: error?.code || 'RESUME_ANALYSIS_FAILED',
        message: error?.message || 'The resume could not be analyzed locally.'
      };
    }
  }

  let fileCreated = false;
  try {
    fs.writeFileSync(storedPath, upload.content, { flag: 'wx', mode: 0o600 });
    fileCreated = true;
    const backup = backupFile(filePath);
    writeJSON(filePath, persistedResumeProfiles(next));
    let candidateProfileBackup = '';
    if (automaticProfileDraft && analysisProfilePath && candidateProfileCanPersist) {
      try {
        if (fs.existsSync(analysisProfilePath)) candidateProfileBackup = backupFile(analysisProfilePath);
        writePrivateJSON(analysisProfilePath, automaticProfileDraft);
      } catch (error) {
        automaticAnalysisError = {
          code: 'CANDIDATE_PROFILE_DRAFT_SAVE_FAILED',
          message: 'The resume was added, but reviewable Candidate Profile facts could not be saved.'
        };
        automaticAnalysis = automaticAnalysis
          ? {
              ...automaticAnalysis,
              persistence: {
                ...automaticAnalysis.persistence,
                candidate_facts_saved: 0,
                candidate_profile_modified: false
              }
            }
          : null;
      }
    }
    let careerBrainBackup = '';
    let careerBrain = publicCareerBrainSummary(readCareerBrainStore());
    let careerBrainError = null;
    let careerBrainAI = { status: 'not_run', model_used: false, raw_text_persisted: false };
    if (automaticProfileDraft) {
      try {
        const currentCareerBrain = readCareerBrainStore();
        const draft = await buildCareerBrainDraft({
          candidateProfile: automaticProfileDraft,
          resumeProfile,
          resumeText: transientResumeText,
          allowAI: body.allow_ai_analysis === true
        });
        careerBrainAI = draft.ai;
        const imported = importCareerProfile(currentCareerBrain, {
          profile: draft.profile,
          name: draft.profile.name,
          now: new Date().toISOString()
        });
        careerBrainBackup = backupFile(CAREER_BRAIN_PATH);
        writeCareerBrainStore(imported.store);
        careerBrain = publicCareerBrainSummary(imported.store);
      } catch (error) {
        careerBrainError = {
          code: error?.code || 'CAREER_BRAIN_DRAFT_SAVE_FAILED',
          message: 'The resume was added, but the Career Brain draft could not be saved.'
        };
      }
    }
    return sendJSON(res, {
      status: 'ok',
      next_view: 'career-brain',
      resume_profile: next.items.find(item => item.resume_id === resumeProfile.resume_id),
      resume_profiles: next,
      backup,
      intake: {
        file_type: upload.extension.slice(1),
        size_bytes: upload.size_bytes,
        content_hash: upload.content_hash,
        content_parsed: Boolean(automaticAnalysis),
        candidate_facts_generated: Boolean(automaticAnalysis?.summary?.suggestion_count),
        candidate_fact_suggestion_count: Number(automaticAnalysis?.summary?.suggestion_count || 0),
        candidate_facts_persisted: Number(automaticAnalysis?.summary?.persisted_fact_count || 0),
        analysis_error: automaticAnalysisError,
        review_required: true
      },
      analysis: automaticAnalysis,
      candidate_profile_backup: candidateProfileBackup,
      career_brain: careerBrain,
      career_brain_backup: careerBrainBackup,
      career_brain_error: careerBrainError,
      career_brain_ai: careerBrainAI,
      safety: {
        stored_locally: true,
        analyzed_locally: Boolean(automaticAnalysis),
        raw_text_saved: false,
        career_brain_draft_created: Boolean(automaticProfileDraft && !careerBrainError),
        invalid_legacy_profile_overwritten: false,
        candidate_facts_user_confirmed: false,
        existing_candidate_facts_overwritten: false,
        external_request_performed: false,
        model_called: careerBrainAI.model_used === true,
        real_site_opened: false,
        external_upload_performed: false,
        resume_attach_enabled: false,
        final_submit_enabled: false,
        automatically_approved: false
      }
    });
  } catch (err) {
    if (fileCreated && fs.existsSync(storedPath)) fs.unlinkSync(storedPath);
    if (err.code === 'EEXIST') {
      return sendJSON(res, {
        status: 'blocked',
        code: 'RESUME_VERSION_COLLISION',
        message: 'The target resume version already exists. Reload Settings and try again.'
      }, 409);
    }
    throw err;
  }
}

function nextActiveResumeId(items, excludedResumeId = '') {
  return items.find(item =>
    item.resume_id !== excludedResumeId
    && item.enabled !== false
    && !item.archived_at
    && item.resume_file_status === 'exists'
  )?.resume_id || '';
}

function verifiedResumeLibraryFile(profile) {
  if (!profile?.resume_file_path || profile.resume_file_status !== 'exists') {
    throw new LocalResumeAnalysisGateError('RESUME_FILE_MISSING', 'The local resume file is missing.', 404);
  }
  const filePath = resolveProjectFileReference(profile.resume_file_path);
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RESUME_UPLOAD_BYTES) {
    throw new LocalResumeAnalysisGateError('RESUME_FILE_CHANGED', 'The local resume file is not a valid resume file.');
  }
  const content = fs.readFileSync(filePath);
  if (!profile.content_hash || !matchesResumeContentHash(content, profile.content_hash)) {
    throw new LocalResumeAnalysisGateError('RESUME_FILE_CHANGED', 'The local resume file no longer matches its registered version.');
  }
  return { filePath, content };
}

async function handleManageResumeProfile(req, res, resumeId) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) {
    return sendJSON(res, { status: 'error', code: 'INVALID_RESUME_ACTION', message: err.message }, 400);
  }
  const action = String(body.action || '').trim().toLowerCase();
  const supported = new Set(['rename', 'delete', 'duplicate', 'archive', 'restore', 'set_active']);
  if (!supported.has(action)) {
    return sendJSON(res, {
      status: 'error',
      code: 'INVALID_RESUME_ACTION',
      message: 'action must be rename, delete, duplicate, archive, restore, or set_active.'
    }, 400);
  }

  const filePath = dataPath('resume_profiles.json');
  const current = normalizeResumeProfiles(readJSON(filePath, defaultResumeProfiles())).value;
  const index = current.items.findIndex(item => item.resume_id === String(resumeId));
  if (index < 0) {
    return sendJSON(res, { status: 'error', code: 'RESUME_NOT_FOUND', message: 'Resume profile not found.' }, 404);
  }
  const selected = current.items[index];
  let items = [...current.items];
  let activeId = current.active_resume_profile_id;
  let affected = selected;
  let deletedLocalCopy = false;

  if (action === 'rename') {
    const name = String(body.name || '').trim();
    if (!name || name.length > 120) {
      return sendJSON(res, {
        status: 'error',
        code: 'INVALID_RESUME_NAME',
        message: 'Resume name must contain 1 to 120 characters.'
      }, 400);
    }
    affected = { ...selected, name, updated_at: new Date().toISOString() };
    items[index] = affected;
  }

  if (action === 'set_active') {
    if (selected.archived_at || selected.enabled === false || selected.resume_file_status !== 'exists') {
      return sendJSON(res, {
        status: 'blocked',
        code: 'RESUME_NOT_ACTIVE_ELIGIBLE',
        message: 'Restore the resume and verify its local file before setting it active.'
      }, 409);
    }
    activeId = selected.resume_id;
  }

  if (action === 'archive') {
    if (body.confirmed !== true) {
      return sendJSON(res, {
        status: 'blocked',
        code: 'RESUME_ARCHIVE_CONFIRMATION_REQUIRED',
        message: 'confirmed=true is required before archiving a resume.'
      }, 409);
    }
    affected = {
      ...selected,
      archived_at: selected.archived_at || new Date().toISOString(),
      enabled: false,
      updated_at: new Date().toISOString()
    };
    items[index] = affected;
    if (activeId === selected.resume_id) activeId = nextActiveResumeId(items, selected.resume_id);
  }

  if (action === 'restore') {
    affected = {
      ...selected,
      archived_at: null,
      enabled: true,
      updated_at: new Date().toISOString()
    };
    items[index] = affected;
    if (!activeId && affected.resume_file_status === 'exists') activeId = affected.resume_id;
  }

  if (action === 'duplicate') {
    const verified = verifiedResumeLibraryFile(selected);
    const extension = path.extname(verified.filePath).toLowerCase();
    const now = new Date().toISOString();
    const duplicate = buildUploadedResumeProfile(current, {
      fileName: path.basename(verified.filePath),
      displayName: `${selected.name} Copy`,
      contentHash: selected.content_hash,
      targetRoles: selected.target_roles,
      language: selected.language,
      now
    });
    const duplicatePath = path.join(RESUME_LIBRARY_DIR, `${duplicate.resume_id}${extension}`);
    fs.mkdirSync(RESUME_LIBRARY_DIR, { recursive: true });
    fs.copyFileSync(verified.filePath, duplicatePath, fs.constants.COPYFILE_EXCL);
    affected = {
      ...duplicate,
      skills: [...(selected.skills || [])],
      experience_summary: selected.experience_summary || '',
      resume_file_path: portableFileReference(duplicatePath),
      file_reference: portableFileReference(duplicatePath),
      duplicated_from_resume_id: selected.resume_id
    };
    items.push(affected);
  }

  if (action === 'delete') {
    if (body.confirmed !== true || body.content_hash !== selected.content_hash) {
      return sendJSON(res, {
        status: 'blocked',
        code: 'RESUME_DELETE_CONFIRMATION_REQUIRED',
        message: 'confirmed=true and the current content_hash are required before deleting a resume.'
      }, 409);
    }
    if (selected.resume_file_status === 'exists') {
      const selectedPath = resolveProjectFileReference(selected.resume_file_path);
      if (isPathInsideDirectory(selectedPath, RESUME_LIBRARY_DIR)) {
        fs.unlinkSync(selectedPath);
        deletedLocalCopy = true;
      }
    }
    items = items.filter(item => item.resume_id !== selected.resume_id);
    if (activeId === selected.resume_id) activeId = nextActiveResumeId(items, selected.resume_id);
  }

  const next = normalizeResumeProfiles({
    active_resume_profile_id: activeId,
    items
  }).value;
  const backup = backupFile(filePath);
  writeJSON(filePath, persistedResumeProfiles(next));
  sendJSON(res, {
    status: 'ok',
    action,
    resume_profile: action === 'delete'
      ? null
      : next.items.find(item => item.resume_id === affected.resume_id) || null,
    resume_profiles: next,
    backup,
    deleted_local_copy: deletedLocalCopy,
    safety: {
      real_site_opened: false,
      external_upload_performed: false,
      final_submit_enabled: false
    }
  });
}

function handleExportResumeProfile(res, resumeId) {
  const current = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles())).value;
  const selected = current.items.find(item => item.resume_id === String(resumeId));
  if (!selected) {
    return sendJSON(res, { status: 'error', code: 'RESUME_NOT_FOUND', message: 'Resume profile not found.' }, 404);
  }
  let verified;
  try {
    verified = verifiedResumeLibraryFile(selected);
  } catch (err) {
    return sendLocalAnalysisError(res, err);
  }
  const extension = path.extname(verified.filePath).toLowerCase();
  const contentType = extension === '.pdf'
    ? 'application/pdf'
    : extension === '.docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'text/plain; charset=utf-8';
  const safeBaseName = String(selected.name || selected.resume_id)
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .slice(0, 100) || 'resume';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': verified.content.length,
    'Content-Disposition': `attachment; filename="${safeBaseName}${extension}"`,
    'Cache-Control': 'no-store'
  });
  res.end(verified.content);
}

async function handleApproveResumeProfile(req, res, resumeId) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) {
    return sendJSON(res, { status: 'error', code: 'INVALID_RESUME_APPROVAL', message: err.message }, 400);
  }
  if (body.confirmed !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'RESUME_APPROVAL_CONFIRMATION_REQUIRED',
      message: 'confirmed=true is required after reviewing this resume version.'
    }, 409);
  }
  const filePath = dataPath('resume_profiles.json');
  const current = normalizeResumeProfiles(readJSON(filePath, defaultResumeProfiles())).value;
  const index = current.items.findIndex(item => item.resume_id === String(resumeId));
  if (index < 0) return sendJSON(res, { status: 'error', code: 'RESUME_NOT_FOUND', message: 'Resume profile not found.' }, 404);
  const selected = current.items[index];
  if (!selected.content_hash || body.content_hash !== selected.content_hash) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'STALE_RESUME_SNAPSHOT',
      message: 'The resume content hash changed or was not reviewed. Reload Settings and review it again.'
    }, 409);
  }
  if (selected.resume_file_status !== 'exists') {
    return sendJSON(res, {
      status: 'blocked',
      code: 'RESUME_FILE_MISSING',
      message: 'The local resume file is missing and cannot be approved.'
    }, 409);
  }
  const selectedPath = resolveProjectFileReference(selected.resume_file_path);
  const selectedStat = fs.statSync(selectedPath);
  if (!selectedStat.isFile() || selectedStat.size > MAX_RESUME_UPLOAD_BYTES) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'RESUME_FILE_CHANGED',
      message: 'The local resume file is no longer a valid approved-size file.'
    }, 409);
  }
  if (!matchesResumeContentHash(fs.readFileSync(selectedPath), selected.content_hash)) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'RESUME_FILE_CHANGED',
      message: 'The local resume file changed after registration. Add it as a new version before approval.'
    }, 409);
  }
  if (selected.approved_at) {
    return sendJSON(res, {
      status: 'ok',
      idempotent_replay: true,
      resume_profile: selected,
      safety: {
        content_hash_reverified: true,
        resume_attached: false,
        real_site_opened: false,
        final_submit_enabled: false
      }
    });
  }
  const approvedAt = new Date().toISOString();
  const items = [...current.items];
  items[index] = {
    ...selected,
    approved_at: approvedAt,
    allow_resume_attach: false,
    allow_final_submit: false
  };
  const next = normalizeResumeProfiles({
    active_resume_profile_id: current.active_resume_profile_id,
    items
  }).value;
  const backup = backupFile(filePath);
  writeJSON(filePath, persistedResumeProfiles(next));
  sendJSON(res, {
    status: 'ok',
    idempotent_replay: false,
    resume_profile: next.items[index],
    backup,
    safety: {
      content_hash_reverified: true,
      resume_attached: false,
      real_site_opened: false,
      final_submit_enabled: false
    }
  });
}

class LocalResumeAnalysisGateError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'LocalResumeAnalysisGateError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function loadResumeForLocalAnalysis(resumeId, expectedHash) {
  const resumes = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles()));
  const selected = resumes.value.items.find(item => item.resume_id === String(resumeId));
  if (!selected) throw new LocalResumeAnalysisGateError('RESUME_NOT_FOUND', 'Resume profile not found.', 404);
  if (!selected.content_hash || expectedHash !== selected.content_hash) {
    throw new LocalResumeAnalysisGateError(
      'STALE_RESUME_SNAPSHOT',
      'The resume content hash changed or was not reviewed. Reload Settings before local analysis.'
    );
  }
  if (selected.resume_file_status !== 'exists') {
    throw new LocalResumeAnalysisGateError('RESUME_FILE_MISSING', 'The local Resume Library file is missing.');
  }
  return selected;
}

async function buildLocalResumeAnalysis(selected) {
  let selectedPath;
  let libraryPath;
  try {
    selectedPath = fs.realpathSync(resolveProjectFileReference(selected.resume_file_path));
    libraryPath = fs.realpathSync(RESUME_LIBRARY_DIR);
  } catch {
    throw new LocalResumeAnalysisGateError('RESUME_FILE_MISSING', 'The local Resume Library file is unavailable.');
  }
  if (!isPathInsideDirectory(selectedPath, libraryPath)) {
    throw new LocalResumeAnalysisGateError(
      'RESUME_OUTSIDE_LOCAL_LIBRARY',
      'Only files copied into the configured local Resume Library can be analyzed.'
    );
  }
  const stat = fs.statSync(selectedPath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RESUME_UPLOAD_BYTES) {
    throw new LocalResumeAnalysisGateError(
      'RESUME_FILE_CHANGED',
      'The local resume is no longer a valid analysis-size file.'
    );
  }
  const content = fs.readFileSync(selectedPath);
  if (!matchesResumeContentHash(content, selected.content_hash)) {
    throw new LocalResumeAnalysisGateError(
      'RESUME_FILE_CHANGED',
      'The local resume changed after registration. Add it as a new version before analysis.'
    );
  }

  const candidate = readCandidateIntelligence(selected);
  const baseAnalysis = await analyzeResumeDocumentRobust({
    content,
    fileName: selectedPath,
    contentHash: selected.content_hash,
    existingFacts: candidate.intelligence?.facts || []
  });
  const suggestions = prepareResumeSuggestionTargets(candidate.profile || {}, baseAnalysis.suggestions);
  return {
    candidate,
    analysis: {
      ...baseAnalysis,
      suggestions,
      summary: {
        ...baseAnalysis.summary,
        applicable_suggestion_count: suggestions.filter(item => item.can_apply_to_existing_profile).length
      }
    }
  };
}

function sendLocalAnalysisError(res, error) {
  if (error instanceof LocalResumeAnalysisGateError || error instanceof ResumeDocumentAnalysisError) {
    sendJSON(res, {
      status: 'blocked',
      code: error.code,
      message: error.message,
      details: error.details || [],
      safety: {
        raw_text_saved: false,
        candidate_profile_modified: false,
        resume_profile_modified: false,
        external_request_performed: false
      }
    }, error instanceof ResumeDocumentAnalysisError ? 422 : error.statusCode);
    return true;
  }
  return false;
}

async function handleAnalyzeResumeProfile(req, res, resumeId) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) {
    return sendJSON(res, { status: 'error', code: 'INVALID_RESUME_ANALYSIS_REQUEST', message: err.message }, 400);
  }
  if (body.confirmed_local_analysis !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'LOCAL_ANALYSIS_CONFIRMATION_REQUIRED',
      message: 'confirmed_local_analysis=true is required before reading the local resume copy.'
    }, 409);
  }
  let selected;
  let analysis;
  try {
    selected = loadResumeForLocalAnalysis(resumeId, body.content_hash);
    ({ analysis } = await buildLocalResumeAnalysis(selected));
  } catch (error) {
    if (sendLocalAnalysisError(res, error)) return;
    throw error;
  }
  sendJSON(res, {
    status: 'ok',
    resume_profile: {
      resume_id: selected.resume_id,
      name: selected.name,
      version: selected.version,
      content_hash: selected.content_hash
    },
    analysis,
    safety: {
      explicit_user_action: true,
      content_hash_reverified: true,
      local_library_boundary_verified: true,
      raw_text_returned: false,
      raw_text_saved: false,
      suggestions_saved: false,
      candidate_profile_modified: false,
      resume_profile_modified: false,
      external_request_performed: false,
      model_called: false,
      resume_uploaded: false,
      final_submit_clicked: false
    }
  });
}

async function handleApplyResumeSuggestions(req, res, resumeId) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) {
    return sendJSON(res, { status: 'error', code: 'INVALID_RESUME_SUGGESTION_REQUEST', message: err.message }, 400);
  }
  if (body.confirmed_apply === true && body.confirmed_local_analysis !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'LOCAL_ANALYSIS_CONFIRMATION_REQUIRED',
      message: 'confirmed_local_analysis=true is required before re-reading the local resume copy.'
    }, 409);
  }
  if (body.confirmed_apply !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'RESUME_SUGGESTION_CONFIRMATION_REQUIRED',
      message: 'confirmed_apply=true is required before changing existing Candidate Profile fields.'
    }, 409);
  }

  let selected;
  let local;
  try {
    selected = loadResumeForLocalAnalysis(resumeId, body.content_hash);
    local = await buildLocalResumeAnalysis(selected);
  } catch (error) {
    if (sendLocalAnalysisError(res, error)) return;
    throw error;
  }
  if (!body.analysis_snapshot_token || body.analysis_snapshot_token !== local.analysis.snapshot_token) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'STALE_RESUME_ANALYSIS',
      message: 'Resume analysis changed after review. Analyze the current local copy again.'
    }, 409);
  }
  if (!local.candidate.profile || !local.candidate.profilePath) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'CANDIDATE_PROFILE_MISSING',
      message: local.candidate.warning || 'Candidate Profile is missing.'
    }, 409);
  }
  let applied;
  try {
    applied = applyResumeFactSuggestions({
      profile: local.candidate.profile,
      suggestions: local.analysis.suggestions,
      selectedSuggestionIds: body.selected_suggestion_ids,
      now: new Date().toISOString()
    });
  } catch (error) {
    return sendJSON(res, {
      status: 'blocked',
      code: error.code || 'RESUME_SUGGESTION_APPLY_FAILED',
      message: error.message,
      details: error.details || []
    }, 409);
  }
  const backup = backupFile(local.candidate.profilePath);
  writeJSON(local.candidate.profilePath, applied.profile);
  sendJSON(res, {
    status: 'ok',
    applied: applied.applied,
    applied_at: applied.applied_at,
    backup,
    resume_intelligence: buildResumeIntelligence({
      profile: applied.profile,
      selectedResume: selected,
      now: applied.applied_at
    }),
    safety: {
      ...applied.safety,
      raw_text_saved: false,
      suggestions_saved: false,
      resume_profile_modified: false,
      real_site_opened: false,
      external_request_performed: false,
      model_called: false,
      resume_uploaded: false,
      final_submit_clicked: false
    }
  });
}

function questionBankPath() {
  return dataPath('question_bank.json');
}

function readAnswerMemory() {
  return normalizeAnswerMemory(readJSON(questionBankPath(), { answers: [] }));
}

function saveAnswerRecord(input) {
  const filePath = questionBankPath();
  const { memory, record } = upsertAnswerMemoryWithResult(readJSON(filePath, { answers: [] }), input);
  const backup = backupFile(filePath);
  writePrivateJSON(filePath, memory);
  return { record, backup };
}

function publicAnswerRecord(record) {
  return {
    question_id: record.question_id,
    original_question: record.original_question,
    normalized_question: record.normalized_question,
    answer: record.answer,
    source: record.source,
    scope: record.scope,
    scope_key: record.scope_key,
    canonical_key: record.canonical_key || '',
    risk_level: record.risk_level || 'normal',
    sensitive_category: record.sensitive_category,
    user_confirmed: record.user_confirmed === true,
    approved_for_real_applications: record.approved_for_real_applications === true,
    status: record.status,
    version: record.version,
    last_confirmed_at: record.last_confirmed_at,
    last_used: record.last_used || null,
    provenance: record.provenance || null,
    updated_at: record.updated_at || null
  };
}

async function handleSaveQuestionAnswer(req, res) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  let saved;
  try {
    // A flat record has a STRING `answer` field; only an OBJECT `answer` is
    // the enveloped form. `body.answer || body` used to feed the answer text
    // itself into the store for flat records — found by the Quick Apply UI.
    saved = saveAnswerRecord(body.answer && typeof body.answer === 'object' ? body.answer : body);
  } catch (err) {
    return sendJSON(res, { status: 'error', code: 'INVALID_ANSWER_MEMORY', message: err.message }, 400);
  }
  sendJSON(res, {
    status: 'ok',
    question_id: saved.record.question_id,
    version: saved.record.version,
    user_confirmed: saved.record.user_confirmed === true,
    approved_for_real_applications: saved.record.approved_for_real_applications === true,
    answer_record: publicAnswerRecord(saved.record),
    backup: saved.backup
  });
}

function handleListAnswers(req, res, url) {
  const memory = readAnswerMemory();
  const scope = String(url?.searchParams?.get('scope') || '').trim();
  const answers = memory.answers
    .filter(answer => !scope || answer.scope === scope)
    .map(publicAnswerRecord);
  sendJSON(res, {
    status: 'ok',
    total: answers.length,
    safe_reusable_answers: answers.filter(answer => answer.approved_for_real_applications).length,
    answers
  });
}

function handleGetAnswer(req, res, questionId) {
  const memory = readAnswerMemory();
  const record = memory.answers.find(answer => answer.question_id === questionId);
  if (!record) return sendJSON(res, { status: 'error', code: 'ANSWER_NOT_FOUND', message: 'No saved answer has this id.' }, 404);
  sendJSON(res, { status: 'ok', answer_record: publicAnswerRecord(record) });
}

async function handleUpdateAnswer(req, res, questionId) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  const memory = readAnswerMemory();
  const existing = memory.answers.find(answer => answer.question_id === questionId);
  if (!existing) return sendJSON(res, { status: 'error', code: 'ANSWER_NOT_FOUND', message: 'No saved answer has this id.' }, 404);
  const patch = body.answer && typeof body.answer === 'object' ? body.answer : body;
  let saved;
  try {
    saved = saveAnswerRecord({
      ...patch,
      id: existing.id,
      question_id: existing.question_id,
      original_question: patch.original_question || existing.original_question,
      answer: patch.answer !== undefined ? patch.answer : existing.answer,
      source: patch.source || existing.source,
      scope: patch.scope || existing.scope,
      scope_key: patch.scope_key !== undefined ? patch.scope_key : existing.scope_key,
      user_confirmed: patch.user_confirmed !== undefined ? patch.user_confirmed : existing.user_confirmed
    });
  } catch (err) {
    return sendJSON(res, { status: 'error', code: 'INVALID_ANSWER_MEMORY', message: err.message }, 400);
  }
  sendJSON(res, { status: 'ok', answer_record: publicAnswerRecord(saved.record), backup: saved.backup });
}

function handleDeleteAnswer(req, res, questionId) {
  const filePath = questionBankPath();
  const memory = readAnswerMemory();
  const record = memory.answers.find(answer => answer.question_id === questionId);
  if (!record) return sendJSON(res, { status: 'error', code: 'ANSWER_NOT_FOUND', message: 'No saved answer has this id.' }, 404);
  const backup = backupFile(filePath);
  writePrivateJSON(filePath, {
    ...memory,
    updated_at: new Date().toISOString(),
    answers: memory.answers.filter(answer => answer.question_id !== questionId)
  });
  sendJSON(res, { status: 'ok', deleted: questionId, backup });
}

function readRequestBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bodyBytes = 0;
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      bodyBytes += chunk.length;
      body += chunk;
      if (bodyBytes > maxBytes) {
        rejected = true;
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (rejected) return;
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getLatestReviews() {
  const reviews = readJSON(dataPath('job_reviews.json'), []);
  const overlay = {};
  for (const review of reviews) {
    if (review && review.job_id) overlay[String(review.job_id)] = review;
  }
  return { reviews, overlay };
}

function getDashboardState() {
  const state = normalizeApplicationExecutionState(readJSON(dataPath('dashboard_state.json'), {}));
  if (!state.application_status_overrides || typeof state.application_status_overrides !== 'object') {
    state.application_status_overrides = {};
  }
  if (!Array.isArray(state.selected_job_ids)) state.selected_job_ids = [];
  if (!Array.isArray(state.audit_events)) state.audit_events = [];
  if (!Array.isArray(state.run_history)) state.run_history = [];
  if (!state.version) state.version = '1.1.0';
  if (!state.created_at) state.created_at = new Date().toISOString();
  return state;
}

function activeSearchProfile() {
  const preferences = normalizeSearchPreferences(readJSON(dataPath('search_preferences.json'), defaultSearchPreferences())).value;
  return preferences.search_profiles.find(profile => profile.id === preferences.active_search_profile_id) || null;
}

function maximumJobsToOpen() {
  return Number(activeSearchProfile()?.maximum_jobs_to_open || 1);
}

function getAllJobRecords() {
  const leads = readJSON(dataPath('job_leads.json'), []);
  const shortlist = readJSON(dataPath('jobs_shortlist.json'), []);
  const records = new Map();
  for (const lead of Array.isArray(leads) ? leads : []) {
    if (!lead?.job_id) continue;
    records.set(String(lead.job_id), { ...lead, inventory_origin: 'job_leads', shortlist_present: false });
  }
  for (const job of Array.isArray(shortlist) ? shortlist : []) {
    if (!job?.job_id) continue;
    const jobId = String(job.job_id);
    records.set(jobId, {
      ...(records.get(jobId) || {}),
      ...job,
      inventory_origin: records.has(jobId) ? 'job_leads+shortlist' : 'jobs_shortlist',
      shortlist_present: true
    });
  }
  return [...records.values()];
}

function findJob(jobId) {
  return getAllJobRecords().find(job => String(job.job_id) === String(jobId));
}

function readJobApprovalEligibility(job) {
  const decision = evaluateApplicationDecision(job);
  return {
    approval_safety: decision.approval_safety || createApprovalSafety('review_only', false, ['invalid_approval_safety']),
    safe_to_approve: decision.allowed,
    blockers: decision.blockers,
    warnings: decision.warnings,
    warning_only: decision.warning_only,
    error: decision.approval_safety_error
  };
}

function approvalBlockersForJob(job, eligibility = readJobApprovalEligibility(job || {})) {
  if (!job) return ['Job record was not found.'];
  return [...new Set((eligibility.blockers || []).filter(Boolean))];
}

function packageContractBlockers(job) {
  if (!job) return ['Job record was not found.'];
  const blockers = [];
  if (job.approval_status !== 'approved') blockers.push('Approve this job first.');
  if (!job.safe_to_approve) blockers.push(...approvalBlockersForJob(job));
  if (job.application_mode !== 'REVIEW_ONLY') blockers.push('Application mode must be REVIEW_ONLY.');
  if (job.submit_allowed !== false) blockers.push('Final submission safety is not locked.');
  if (job.upload_resume_allowed !== false) blockers.push('Resume upload safety is not locked.');
  if (job.final_submit_allowed !== false) blockers.push('Manual final-submit safety is not locked.');
  return [...new Set(blockers.filter(Boolean))];
}

function deriveJobLifecycleStatus({ job = {}, review = null, applicationStatus = '' } = {}) {
  const app = String(applicationStatus || '').toUpperCase();
  if (['MANUALLY_SUBMITTED', 'SUBMITTED_MANUALLY', 'INTERVIEW'].includes(app)) return 'applied';
  if (app === 'MANUAL_ONLY') return 'manual_only';
  if (app === 'UNSUPPORTED') return 'unsupported';
  if (app === 'CANCELLED') return 'saved';
  if (app === 'SAVED') return 'saved';
  if (app === 'REJECTED') return 'rejected';
  if (app === 'ARCHIVED') return 'archived';
  if (['APPROVED_FOR_PACKAGE', 'PACKAGE_READY', 'FILL_APPROVED', 'EXECUTOR_READY', 'EXECUTING', 'NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT'].includes(app)) return 'approved';
  const decision = String(review?.decision || job.approval_status || 'pending').toLowerCase();
  if (decision === 'approved') return 'approved';
  if (decision === 'rejected') return 'rejected';
  if (decision === 'archived') return 'archived';
  if (decision === 'manual_review') return 'saved';
  return 'new';
}

function portalCapabilityForJob(job = {}) {
  const jobUrl = String(job.canonical_url || job.url || '').trim();
  const applicationUrl = resolveApplicationPageUrl(job);
  let parsed;
  try { parsed = new URL(applicationUrl || jobUrl); }
  catch {
    return {
      code: 'unsupported_page_type',
      label: 'Unsupported page type',
      message: 'This record does not have a valid public job or application URL.',
      action: 'Import the actual application URL',
      application_url: ''
    };
  }
  const host = parsed.hostname.toLowerCase();
  const pathName = parsed.pathname.toLowerCase();
  const pageType = String(job.page_type || 'unknown');
  if (['aggregator_search', 'company_careers_home', 'unknown'].includes(pageType) && !job.shortlist_present) {
    return {
      code: 'application_url_missing',
      label: 'Application URL missing',
      message: 'We found a job record, but it has not completed detail-page verification.',
      action: 'Import or verify the actual application URL',
      application_url: applicationUrl || ''
    };
  }
  if (host === 'jobs.lever.co' && /\/apply\/?$/.test(pathName)) {
    return {
      code: 'supported_safe_fill',
      label: 'Application form supported',
      message: 'Safe contact fields can be detected and filled after package review.',
      action: 'Build the Application Package',
      application_url: parsed.href
    };
  }
  if ((host.includes('greenhouse.io') || host.includes('ashbyhq.com')) && applicationUrl) {
    return {
      code: 'supported_safe_fill',
      label: 'Application form supported',
      message: 'Safe contact fields can be detected and filled after package review.',
      action: 'Build the Application Package',
      application_url: parsed.href
    };
  }
  if (host.includes('myworkdayjobs.com')) {
    return {
      code: 'detection_only',
      label: 'Open and complete manually',
      message: 'The form can be inspected, but safe filling is not available for every field.',
      action: 'Open the application page',
      application_url: parsed.href
    };
  }
  if (/login|signin|sign-in/.test(pathName)) {
    return {
      code: 'login_required',
      label: 'Sign-in is required',
      message: 'Sign in manually before continuing. Resume Jobs never enters credentials.',
      action: 'Open the application page',
      application_url: parsed.href
    };
  }
  if (!applicationUrl) {
    return {
      code: 'application_url_missing',
      label: 'Application URL missing',
      message: 'We found the job page but not the application form.',
      action: 'Import the actual application URL',
      application_url: ''
    };
  }
  return {
    code: 'manual_application',
    label: 'Open and complete manually',
    message: 'Safe filling is not available for this page yet.',
    action: 'Open the application page',
    application_url: parsed.href
  };
}

function currentJobInventoryClass({ job, applicationStatus, lifecycleStatus, eligibility, packageStatus, session }) {
  if (applicationStatus === 'RECOVERY_REQUIRED') return 'Stale or legacy state requiring recovery';
  if (applicationStatus === 'MANUAL_ONLY' || lifecycleStatus === 'manual_only') return 'Unsupported portal/manual-only';
  if (applicationStatus === 'UNSUPPORTED' || lifecycleStatus === 'unsupported') return 'Unsupported portal/manual-only';
  if (!eligibility.safe_to_approve && ['aggregator_search', 'company_careers_home', 'unknown'].includes(String(job.page_type || 'unknown'))) {
    return 'Hard-blocked because it is not a valid job/application detail';
  }
  if (['EXECUTOR_READY', 'EXECUTING', 'NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT'].includes(applicationStatus)) return 'Existing application in progress';
  if (applicationStatus === 'PACKAGE_READY') return 'Approved and package-ready';
  if (lifecycleStatus === 'rejected') return 'Rejected but restorable';
  if (eligibility.warning_only && eligibility.safe_to_approve) return 'Warning-only but approvable';
  return 'Ready to review';
}

function getJobsWithOverlay() {
  const jobsShortlist = getAllJobRecords();
  const { overlay } = getLatestReviews();
  const state = getDashboardState();
  const applicationOverrides = state.application_status_overrides || {};
  const selectedJobIds = new Set((state.selected_job_ids || []).map(String));

  return jobsShortlist.map(job => {
    const jobId = String(job.job_id || '');
    const review = overlay[jobId];
    const appOverride = applicationOverrides[jobId];
    const pageType = job.page_type || 'unknown';
    const recommendedDecision = job.recommended_decision || 'manual_review';
    const eligibility = readJobApprovalEligibility({
      ...job,
      page_type: pageType,
      recommended_decision: recommendedDecision
    });
    const approvalSafety = eligibility.approval_safety;
    const approvalWarning = job.approval_warning || eligibility.error?.message || '';
    const qualityFlags = job.quality_flags || {};
    const safeToApprove = eligibility.safe_to_approve;
    const sourceCategory = categorizeJobSource(job);
    const applicationStatus = deriveApplicationStatus({ job, review, override: appOverride });
    const lifecycleStatus = deriveJobLifecycleStatus({ job, review, applicationStatus });
    const approvalBlockers = approvalBlockersForJob(job, eligibility);
    const session = appOverride?.active_session_id
      ? state.application_execution_sessions?.[appOverride.active_session_id] || null
      : null;
    const publicState = publicApplicationStateFor({
      applicationStatus,
      session,
      liveness: session ? sessionLivenessSnapshot(session) : null,
      awaitingVerification: awaitingVerificationFor(appOverride, session)
    });
    const portalCapability = portalCapabilityForJob({ ...job, shortlist_present: job.shortlist_present === true });
    const packageStatus = appOverride?.package_status || job.package_status || 'not_created';
    const nextAction = approvalBlockers.length
      ? (portalCapability.action || 'Review the blocker details')
      : lifecycleStatus === 'rejected'
        ? 'Restore to review'
        : applicationStatus === 'APPROVED_FOR_PACKAGE'
          ? 'Build Application Package'
          : applicationStatus === 'PACKAGE_READY'
            ? 'Review package and approve AI Fill'
            : applicationStatus === 'NEEDS_REVIEW'
              ? 'Review remaining fields and re-scan'
              : job.next_action || 'Review this job';

    return {
      job_id: job.job_id,
      title: job.title,
      company: job.company,
      location: job.location,
      country: job.country || job.country_or_region || '',
      remote: job.remote || '',
      source: job.source || '',
      source_type: job.source_type || '',
      source_market: job.source_market || sourceCategory.market,
      source_category: job.source_category || sourceCategory.category,
      source_category_label: job.source_category_label || sourceCategory.label,
      source_job_id: job.source_job_id || '',
      provider: job.provider,
      ats: job.ats,
      url: job.url,
      canonical_url: job.canonical_url || job.url,
      salary: job.salary || null,
      requirements: job.requirements || [],
      posted_date: job.posted_date || job.posted_at || '',
      first_seen: job.first_seen || job.first_seen_at || job.discovered_at || '',
      last_seen: job.last_seen || job.last_seen_at || job.first_seen_at || job.discovered_at || '',
      times_seen: Math.max(1, Number(job.times_seen || job.discovery_memory?.times_seen) || 1),
      discovery_status: job.discovery_status || job.discovery_memory?.status || ((Number(job.times_seen || job.discovery_memory?.times_seen) || 1) > 1 ? 'previously_seen' : 'new'),
      search_query: job.search_query || job.discovery?.query || 'Not recorded',
      search_time: job.search_time || job.discovery?.searched_at || job.discovered_at || '',
      why_discovered: job.why_discovered || job.discovery?.why_discovered || 'Discovered from a public job source.',
      discovery: job.discovery || null,
      discovery_rank: job.discovery_rank || null,
      search_configuration_fingerprint: job.search_configuration_fingerprint || '',
      match_score: job.match_score,
      match_scores: canonicalMatchScores(job),
      match_reasons: job.match_reasons,
      score_breakdown: job.score_breakdown || null,
      hybrid_match: job.hybrid_match || null,
      ai_enrichment: job.ai_enrichment || null,
      hard_filter: job.hard_filter || null,
      shortlist_status: job.shortlist_status,
      application_mode: job.application_mode,
      submit_allowed: job.submit_allowed,
      upload_resume_allowed: job.upload_resume_allowed,
      final_submit_allowed: job.final_submit_allowed,
      approval_status: review?.decision || job.approval_status || 'pending',
      approval_reason: review?.reason || '',
      approval_notes: review?.notes || '',
      decided_at: review?.decided_at || null,
      application_status: applicationStatus,
      lifecycle_status: lifecycleStatus,
      // Records marked invalid_non_job by the inventory repair pass (navigation
      // pages that were never jobs) stay stored but never surface by default.
      invalid_non_job: job.invalid_non_job === true,
      invalid_reasons: Array.isArray(job.invalid_reasons) ? job.invalid_reasons : [],
      search_match: job.search_match || null,
      shortlisted: job.shortlisted === true,
      // Saved is a durable user flag, independent of application progress:
      // entering the apply flow must never silently drop it. The legacy
      // SAVED application status and shortlist_status still count.
      saved: job.saved === true || applicationStatus === 'SAVED' || job.shortlist_status === 'saved',
      // The same public word apply-state returns — the UI reads this, never
      // the internal application_status machine constants.
      public_state: publicState.state,
      public_state_resumable: publicState.resumable,
      ignored_forever: job.ignored_forever === true,
      suppressed_from_default: job.invalid_non_job === true
        || job.ignored_forever === true
        || isSuppressedFromDefaultResults({ lifecycleStatus, applicationStatus }),
      approval_blockers: approvalBlockers,
      approval_warnings: eligibility.warnings || [],
      approval_warning_only: eligibility.warning_only === true,
      package_status: packageStatus,
      package_path: appOverride?.package_path || job.package_path || '',
      application_status_updated_at: appOverride?.updated_at || null,
      selected_for_fill: selectedJobIds.has(jobId),
      fill_approved_at: appOverride?.fill_approved_at || null,
      fill_started_at: appOverride?.fill_started_at || null,
      latest_fill_report: appOverride?.latest_fill_report || null,
      application_completion: appOverride?.application_completion || null,
      application_id: appOverride?.application_id || `application_${safeJobSegment(jobId)}`,
      active_session_id: appOverride?.active_session_id || '',
      active_session_status: session?.execution_status || '',
      package_id: appOverride?.package_id || '',
      page_type: pageType,
      approval_safety: approvalSafety,
      approval_warning: approvalWarning,
      recommended_decision: recommendedDecision,
      quality_flags: qualityFlags,
      safe_to_approve: safeToApprove,
      approval_safety_error: eligibility.error,
      next_action: nextAction,
      available_actions: applicationAllowedTransitions(applicationStatus),
      portal_capability: portalCapability,
      application_url: portalCapability.application_url || '',
      inventory_origin: job.inventory_origin || '',
      shortlist_present: job.shortlist_present === true,
      inventory_class: currentJobInventoryClass({
        job,
        applicationStatus,
        lifecycleStatus,
        eligibility,
        packageStatus,
        session
      }),
      package_blockers: packageContractBlockers({
        ...job,
        approval_status: review?.decision || job.approval_status || 'pending',
        safe_to_approve: safeToApprove
      }),
      warning: approvalWarning || (
        ['aggregator_search', 'company_careers_home', 'unknown'].includes(pageType)
          ? 'Review only — not a confirmed job detail page.'
          : ''
      )
    };
  });
}

function workflowSummary() {
  const jobs = getJobsWithOverlay();
  const approvedIds = new Set(jobs.filter(job => job.approval_status === 'approved' && job.safe_to_approve).map(job => String(job.job_id)));
  const state = getDashboardState();
  const selectedJobIds = (state.selected_job_ids || []).map(String).filter(jobId => approvedIds.has(jobId));
  return {
    maximum_jobs_to_open: maximumJobsToOpen(),
    selected_job_ids: selectedJobIds,
    selected_count: selectedJobIds.length,
    approved_job_count: approvedIds.size,
    safety: {
      approved_jobs_only: true,
      final_submit_manual_only: true,
      resume_upload_requires_explicit_confirmation: true
    }
  };
}

function handleWorkflow(res) {
  sendJSON(res, workflowSummary());
}

function handleApplicationAudit(res, jobId = '') {
  const state = getDashboardState();
  const filterId = String(jobId || '');
  const events = (state.audit_events || []).filter(event => !filterId || String(event.job_id) === filterId);
  const sessions = Object.values(state.application_execution_sessions || {}).filter(session => !filterId || String(session.job_id) === filterId);
  sendJSON(res, {
    status: 'ok',
    job_id: filterId,
    event_count: events.length,
    session_count: sessions.length,
    events,
    application_execution_sessions: sessions
  });
}

async function handleSaveWorkflowSelection(req, res) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  if (!Array.isArray(body.job_ids)) return sendJSON(res, { status: 'error', message: 'job_ids must be an array' }, 400);
  const requested = [...new Set(body.job_ids.map(value => String(value).trim()).filter(Boolean))];
  const maximum = maximumJobsToOpen();
  if (requested.length > maximum) {
    return sendJSON(res, {
      status: 'blocked',
      message: `Selection exceeds maximum_jobs_to_open (${maximum}).`,
      maximum_jobs_to_open: maximum,
      requested_count: requested.length
    }, 409);
  }
  const jobs = getJobsWithOverlay();
  const eligibleIds = new Set(jobs.filter(job => job.approval_status === 'approved' && job.safe_to_approve).map(job => String(job.job_id)));
  const ineligible = requested.filter(jobId => !eligibleIds.has(jobId));
  if (ineligible.length) {
    return sendJSON(res, {
      status: 'blocked',
      message: 'Only approved, safety-eligible jobs can be selected.',
      ineligible_job_ids: ineligible
    }, 409);
  }
  const filePath = dataPath('dashboard_state.json');
  const backup = backupFile(filePath);
  const state = getDashboardState();
  state.selected_job_ids = requested;
  state.updated_at = new Date().toISOString();
  const audited = appendAuditEvent(state, {
    eventType: 'SELECTION_CHANGED',
    actor: 'user_dashboard',
    reason: 'persisted_approved_job_selection',
    metadata: { selected_job_ids: requested, selected_count: requested.length, maximum_jobs_to_open: maximum }
  });
  writeJSON(filePath, audited.state);
  publishDashboardEvent('SELECTION_CHANGED', {
    status: 'SELECTION_UPDATED',
    message: `${requested.length} approved job(s) selected for applications.`
  });
  sendJSON(res, { status: 'ok', ...workflowSummary(), backup });
}

function handleSummary(res) {
  const jobLeads = readJSON(dataPath('job_leads.json'), []);
  const jobs = getJobsWithOverlay();
  const approved = jobs.filter(job => job.approval_status === 'approved').length;
  const rejected = jobs.filter(job => job.approval_status === 'rejected').length;
  const manualReview = jobs.filter(job => job.approval_status === 'manual_review').length;

  const providerCounts = {};
  const applicationStatusCounts = {};
  const approvalStatusCounts = { pending: 0, approved: 0, rejected: 0, manual_review: 0 };
  const scoreBuckets = { '90-100': 0, '80-89': 0, '70-79': 0, '60-69': 0, '<60': 0 };
  const completionRecords = jobs
    .filter(job => job.approval_status === 'approved' && job.application_completion)
    .map(job => job.application_completion)
    .filter(record => Number.isFinite(Number(record.application_completion_rate)));

  for (const job of jobs) {
    const provider = job.provider || 'unknown';
    providerCounts[provider] = (providerCounts[provider] || 0) + 1;
    const appStatus = job.application_status || 'not_started';
    applicationStatusCounts[appStatus] = (applicationStatusCounts[appStatus] || 0) + 1;
    const approvalStatus = job.approval_status || 'pending';
    approvalStatusCounts[approvalStatus] = (approvalStatusCounts[approvalStatus] || 0) + 1;
    const score = Number(job.match_score) || 0;
    if (score >= 90) scoreBuckets['90-100']++;
    else if (score >= 80) scoreBuckets['80-89']++;
    else if (score >= 70) scoreBuckets['70-79']++;
    else if (score >= 60) scoreBuckets['60-69']++;
    else scoreBuckets['<60']++;
  }

  const averageCompletionRate = completionRecords.length
    ? Math.round(completionRecords.reduce((sum, record) => sum + Number(record.application_completion_rate || 0), 0) / completionRecords.length)
    : null;
  const fieldsRequiringReview = completionRecords.reduce((sum, record) => {
    if (Array.isArray(record.blockers)) return sum + record.blockers.length;
    return sum
      + Number(record.user_review_fields_count || 0)
      + Number(record.unknown_fields_count || 0);
  }, 0);
  const completionInsights = aggregateCompletionInsights(completionRecords);

  sendJSON(res, {
    job_leads_count: Array.isArray(jobLeads) ? jobLeads.length : 0,
    jobs_shortlist_count: jobs.length,
    approved_count: approved,
    rejected_count: rejected,
    manual_review_count: manualReview,
    pending_count: jobs.filter(job => job.approval_status === 'pending').length,
    provider_breakdown: providerCounts,
    score_buckets: scoreBuckets,
    approval_status_breakdown: approvalStatusCounts,
    application_status_breakdown: applicationStatusCounts,
    application_completion: {
      metric: 'application_completion_rate',
      approved_jobs_measured: completionRecords.length,
      approved_jobs_total: approved,
      average_completion_rate: averageCompletionRate,
      fields_requiring_user_review: fieldsRequiringReview,
      ready_for_30_second_review_count: completionRecords.filter(record => record.ready_for_30_second_review === true).length,
      insights: completionInsights
    },
    running_job: runningJob,
    generated_at: new Date().toISOString()
  });
}

function handleJobs(res) {
  sendJSON(res, getJobsWithOverlay());
}

function handleProviderHealth(res) {
  const sources = publicConfiguredJobSearchSources(readJSON(dataPath('job_sources.json'), {}));
  const discoveryHealth = readJSON(dataPath('provider_health.json'), {});
  sendJSON(res, {
    generated_at: new Date().toISOString(),
    providers: sources.providers,
    offline_demo: sources.offline_demo,
    ai_enrichment: sources.ai_enrichment,
    downstream_adapters: sources.downstream_adapters,
    discovery_health: discoveryHealth && typeof discoveryHealth === 'object' && !Array.isArray(discoveryHealth)
      ? discoveryHealth
      : {}
  });
}


function handleDailyAutomationLatest(res) {
  let latest = null;
  try {
    latest = fs.readdirSync(REPORTS_DIR)
      .filter(name => /^daily_automation_\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map(name => {
        const filePath = path.join(REPORTS_DIR, name);
        return { name, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
  } catch {
    latest = null;
  }

  if (!latest) {
    return sendJSON(res, {
      status: 'missing',
      message: 'No daily automation report found yet.',
      safety: {
        browser_opened: false,
        chrome_extension_called: false,
        apply_submit_clicked: false,
        resume_uploaded: false,
        application_submitted: false
      }
    });
  }

  const report = readJSON(latest.filePath, {});
  sendJSON(res, {
    status: report.status || 'unknown',
    report_path: path.relative(PROJECT_ROOT, latest.filePath),
    report_md_path: path.relative(PROJECT_ROOT, latest.filePath).replace(/\.json$/, '.md'),
    date: report.date || '',
    blocked_step: report.blocked_step || null,
    blocked_reason: report.blocked_reason || null,
    searxng: report.searxng || {},
    counts_after: report.counts_after || {},
    deltas: report.deltas || {},
    safety: report.safety || {
      browser_opened: false,
      chrome_extension_called: false,
      apply_submit_clicked: false,
      resume_uploaded: false,
      application_submitted: false
    }
  });
}

function tailText(text, maxChars = 4000) {
  if (!text) return '';
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

function runCommand(res, runType, command, args, filesTouched) {
  if (runningJob) {
    return sendJSON(res, {
      status: 'busy',
      message: `Another job is running: ${runningJob.type}`,
      running_job: runningJob
    }, 409);
  }

  const startedAt = new Date().toISOString();
  runningJob = { type: runType, command: [command, ...args].join(' '), started_at: startedAt };

  execFile(command, args, {
    cwd: PROJECT_ROOT,
    env: productProcessEnv(),
    timeout: runType === 'discovery' ? 5 * 60 * 1000 : 10 * 60 * 1000,
    maxBuffer: 1024 * 1024 * 10
  }, (error, stdout, stderr) => {
    const finishedAt = new Date().toISOString();
    let commandResult = null;
    let outputParseWarning = '';
    try {
      commandResult = stdout ? JSON.parse(stdout) : null;
    } catch {
      outputParseWarning = 'The command finished but returned an unreadable result.';
    }
    const domainFailure = Boolean(
      commandResult
      && runType === 'discovery'
      && commandResult.status !== 'ok'
    );
    const result = {
      status: error || domainFailure ? 'failed' : 'completed',
      output_parse_warning: outputParseWarning,
      run_type: runType,
      started_at: startedAt,
      finished_at: finishedAt,
      stdout_tail: tailText(stdout),
      stderr_tail: tailText(stderr || error?.message || ''),
      code: commandResult?.status || (error ? 'COMMAND_FAILED' : 'COMPLETED'),
      message: commandResult?.reason || commandResult?.exact_error || '',
      domain_result: commandResult,
      files_touched: filesTouched,
      safety: {
        browser_opened: false,
        chrome_extension_called: false,
        apply_submit_clicked: false,
        resume_uploaded: false,
        application_submitted: false
      }
    };
    if (runType === 'discovery' && commandResult) {
      const reachable = commandResult.searxng_reachable === true;
      updateSavedProviderHealth({
        status: reachable ? 'READY' : 'UNREACHABLE',
        last_health_check: new Date().toISOString(),
        last_error: reachable ? '' : String(commandResult.exact_error || commandResult.reason || 'Search provider became unavailable.')
      });
    }

    const state = getDashboardState();
    state.last_run = result;
    state.run_history.push(result);
    state.run_history = state.run_history.slice(-25);
    writeJSON(dataPath('dashboard_state.json'), state);
    runningJob = null;
    sendJSON(res, result, error || domainFailure ? 500 : 200);
  });
}

async function liveSearchPreflight() {
  const search = normalizeSearchPreferences(readJSON(dataPath('search_preferences.json'), defaultSearchPreferences())).value;
  const active = search.search_profiles.find(profile => profile.id === search.active_search_profile_id) || null;
  if (!search.workflow_meta?.configured_at
    || !active
    || active.enabled === false
    || !active.target_roles?.some(item => item?.enabled !== false && String(item?.keyword || item || '').trim())) {
    return {
      ok: false,
      code: 'SEARCH_CONFIGURATION_REQUIRED',
      message: 'Save a target role in Job Search before finding jobs.'
    };
  }
  const sources = normalizeJobSearchSources(readJSON(dataPath('job_sources.json'), {}));
  const provider = effectiveJobSearchProvider(sources);
  if (!provider.enabled) {
    return {
      ok: false,
      code: 'LIVE_SEARCH_NOT_CONFIGURED',
      message: 'Live Search is disabled. Configure and enable a Job Search Source in Settings, or use the clearly labeled Offline Demo.',
      requirements: {
        provider: 'SearXNG-compatible search provider',
        provider_status: 'Enabled and READY',
        provider_url: 'Settings → Job Search Sources → SearXNG endpoint'
      }
    };
  }
  if (!provider.url) {
    const health = {
      status: 'MISCONFIGURED',
      last_health_check: new Date().toISOString(),
      last_error: 'SearXNG endpoint is missing.'
    };
    updateSavedProviderHealth(health);
    return {
      ok: false,
      code: 'LIVE_SEARCH_NOT_CONFIGURED',
      message: health.last_error,
      requirements: {
        provider: 'SearXNG-compatible search provider',
        provider_url: 'Settings → Job Search Sources → SearXNG endpoint'
      }
    };
  }
  const health = await testSearxngConnection(provider);
  updateSavedProviderHealth(health);
  if (!health.ok) {
    return {
      ok: false,
      code: health.status === 'MISCONFIGURED' ? 'LIVE_SEARCH_NOT_CONFIGURED' : 'SEARCH_PROVIDER_UNAVAILABLE',
      message: health.last_error,
      provider_status: health.status,
      requirements: {
        provider: 'SearXNG-compatible search provider',
        provider_status: 'READY'
      }
    };
  }
  return {
    ok: true,
    provider: 'searxng_search',
    provider_url: provider.url,
    provider_url_source: provider.url_source,
    timeout_ms: provider.timeout_ms,
    max_results_per_query: provider.max_results_per_query,
    provider_status: health.status
  };
}

async function handleRun(res, runType) {
  if (runType === 'discovery') {
    const preflight = await liveSearchPreflight();
    if (!preflight.ok) {
      return sendJSON(res, {
        status: 'blocked',
        run_type: 'discovery',
        ...preflight,
        safety: {
          network_accessed: false,
          real_site_opened: false,
          login_attempted: false,
          resume_uploaded: false,
          final_submit_clicked: false
        }
      }, 409);
    }
    return runCommand(res, 'discovery', 'node', [
      'scripts/discover_jobs.mjs',
      '--allow-live-search',
      '--max-queries', '5',
      '--max-results-per-query', String(preflight.max_results_per_query),
      '--timeout-ms', String(preflight.timeout_ms),
      '--searxng-url', preflight.provider_url
    ], [
      'data/job_leads.json',
      'data/search_runs.json',
      'data/provider_health.json'
    ]);
  }
  if (runType === 'scoring') {
    return runCommand(res, 'scoring', 'node', ['scripts/score_jobs.mjs'], [
      'data/jobs_shortlist.json',
      'reports/jobs_scoring_preview_001.json',
      'reports/jobs_scoring_preview_001.md'
    ]);
  }
  if (runType === 'ai-enrichment') {
    const ai = configuredAIProviderStatus();
    if (ai.status !== 'READY') {
      return sendJSON(res, {
        status: 'blocked',
        run_type: 'ai-enrichment',
        code: 'AI_ENRICHMENT_UNAVAILABLE',
        message: ai.message,
        safety: {
          search_provider_changed: false,
          deterministic_scores_changed: false,
          application_state_changed: false
        }
      }, 409);
    }
    return runCommand(res, 'ai-enrichment', 'node', ['scripts/enrich_jobs_with_local_model.mjs'], [
      'data/jobs_shortlist.json'
    ]);
  }
  if (runType === 'approval-queue') {
    return runCommand(res, 'approval-queue', 'node', ['scripts/build_approval_queue.mjs'], [
      'reports/approval_queue_latest.md'
    ]);
  }
  sendJSON(res, { status: 'error', message: 'Unknown run type' }, 404);
}

// Discovers postings behind a company careers URL. Preview by default; only
// import:true writes anything, and it writes through the same merge path the
// single-URL import uses, so dedup and rejection history keep working.
async function handleImportCompanyCareers(req, res) {
  let body = {};
  try { body = await readRequestBody(req, { maxBytes: 16 * 1024 }); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_IMPORT_REQUEST', message: error.message }, 400); }

  if (body.confirmed_public_fetch !== true) {
    return sendJSON(res, {
      status: 'blocked', code: 'PUBLIC_FETCH_CONFIRMATION_REQUIRED',
      message: 'Confirm fetching this public careers page before discovery runs.',
      safety: { network_accessed: false }
    }, 409);
  }

  let discovery;
  try {
    discovery = await discoverCompanyJobs(String(body.url || ''), {
      limit: Math.min(Number(body.limit) || 50, 50)
    });
  } catch (error) {
    // Typed rejections from the SSRF/scheme validation.
    return sendJSON(res, {
      status: 'blocked', code: error.code || 'CAREERS_URL_REJECTED', message: error.message
    }, error.status || 400);
  }

  if (body.import !== true || !discovery.jobs.length) {
    return sendJSON(res, {
      status: 'ok', mode: 'preview',
      ...discovery,
      imported_count: 0,
      files_touched: []
    });
  }

  const now = new Date().toISOString();
  const search = normalizeSearchPreferences(readJSON(dataPath('search_preferences.json'), defaultSearchPreferences())).value;
  const active = search.search_profiles.find(profile => profile.id === search.active_search_profile_id) || null;
  const scoredAgainstPreferences = Boolean(
    search.workflow_meta?.configured_at && active && active.enabled !== false
    && active.target_roles?.some(item => item?.enabled !== false && String(item?.keyword || item || '').trim())
  );
  const fingerprint = searchConfigurationFingerprint(search);
  const importedJobs = discovery.jobs.map(job => ({
    ...job,
    source: 'user_supplied_career_url',
    discovery: { source: job.source, query: '', searched_at: now, provider: discovery.provider },
    search_configuration_fingerprint: fingerprint
  }));
  const existing = readJSON(dataPath('job_leads.json'), []);
  const merged = mergeJobRecords(Array.isArray(existing) ? existing : [], importedJobs, { now });
  const runsValue = readJSON(dataPath('search_runs.json'), []);
  const runs = Array.isArray(runsValue) ? runsValue : (Array.isArray(runsValue?.runs) ? runsValue.runs : []);
  const backups = [backupFile(dataPath('job_leads.json')), backupFile(dataPath('search_runs.json'))];
  writeJSON(dataPath('job_leads.json'), merged.jobs);
  writeJSON(dataPath('search_runs.json'), [...runs, {
    run_id: `company_careers_${Date.parse(now) || Date.now()}`,
    search_configuration_fingerprint: fingerprint,
    search_profile_id: active?.id || '',
    status: 'completed',
    started_at: now,
    completed_at: now,
    provider: 'company_careers_import',
    detected_provider: discovery.provider,
    provider_reachable: true,
    discovered_urls_count: importedJobs.length,
    deduped_jobs_count: merged.jobs.length,
    duplicates_merged: merged.duplicates_merged,
    mode: 'company_careers_import',
    network_accessed: true
  }].slice(-100));

  return sendJSON(res, {
    status: 'ok', mode: 'imported',
    ...discovery,
    imported_count: importedJobs.length,
    duplicates_merged: merged.duplicates_merged,
    scored_against_preferences: scoredAgainstPreferences,
    files_touched: ['data/job_leads.json', 'data/search_runs.json'],
    backups
  });
}

// AI provider status for the UI: everything a settings screen needs, nothing a
// credential thief wants. No key, no live network call.
function handleAIStatus(res) {
  const settings = configuredAIProviderStatus();
  sendJSON(res, {
    status: 'ok',
    enabled: settings.enabled === true,
    provider_type: settings.type || 'disabled',
    // The saved endpoint (never the key) so the settings form can show what
    // it will actually talk to instead of a placeholder.
    endpoint: settings.base_url || '',
    model: settings.model || '',
    credential_configured: settings.credential_configured === true,
    ready: settings.enabled === true && Boolean(settings.model),
    safety: { credential_returned: false, network_accessed: false }
  });
}

// The application history that survives "clear job materials": what you
// applied to, when, and how far it got. Terminal states only — in-flight
// applications belong to /api/jobs/:id/apply-state.
const HISTORY_STATUSES = new Set(['MANUALLY_SUBMITTED', 'SUBMITTED', 'READY_FOR_MANUAL_SUBMIT', 'REJECTED']);

// Every status from which the user may declare "I submitted this on the site
// myself". The user's own declaration is ground truth, so this is broader than
// READY_FOR_MANUAL_SUBMIT — but it excludes EXECUTOR_READY/EXECUTING, where an
// automated fill is actively running and a stray click would cut it off.
// RECOVERY_REQUIRED is included: an uncertain-submit crash is resolved by the
// user telling us what actually happened.
const USER_DECLARABLE_SUBMIT_STATUSES = new Set([
  'REVIEW_PENDING', 'SAVED', 'APPROVED_FOR_PACKAGE', 'PACKAGE_READY', 'FILL_APPROVED',
  'NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT', 'RECOVERY_REQUIRED'
]);

function handleApplicationsHistory(res) {
  const state = getDashboardState();
  const jobs = getJobsWithOverlay();
  const entries = [];
  for (const [jobId, record] of Object.entries(state.application_status_overrides || {})) {
    const status = normalizeApplicationStatus(record?.application_status || '');
    if (!HISTORY_STATUSES.has(status)) continue;
    const job = jobs.find(item => String(item.job_id) === String(jobId)) || {};
    entries.push({
      job_id: String(jobId),
      title: String(job.title || record.title || ''),
      company: String(job.company || record.company || ''),
      state: PUBLIC_APPLICATION_STATUS[status] || 'found',
      submitted_at: String(record.manually_submitted_at || record.submitted_at || record.updated_at || ''),
      url: String(job.canonical_url || job.url || '')
    });
  }
  entries.sort((left, right) => String(right.submitted_at).localeCompare(String(left.submitted_at)));
  sendJSON(res, { status: 'ok', total: entries.length, applications: entries });
}

async function handleImportJobUrl(req, res) {
  let body = {};
  try { body = await readRequestBody(req, { maxBytes: 16 * 1024 }); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_IMPORT_REQUEST', message: error.message }, 400); }

  const search = normalizeSearchPreferences(readJSON(dataPath('search_preferences.json'), defaultSearchPreferences())).value;
  const active = search.search_profiles.find(profile => profile.id === search.active_search_profile_id) || null;
  const configured = Boolean(
    search.workflow_meta?.configured_at && active && active.enabled !== false
    && active.target_roles?.some(item => item?.enabled !== false && String(item?.keyword || item || '').trim())
  );
  // Pasting a job link is the first thing a new user does and the only
  // discovery path that always works, so it must not depend on search being
  // configured. Without a target role the job is still imported; it simply
  // cannot be scored against preferences that do not exist yet.
  const scoredAgainstPreferences = configured;

  try {
    const now = new Date().toISOString();
    const imported = await ingestPublicJobUrl(body.url, {
      confirmedPublicFetch: body.confirmed_public_fetch === true,
      timeoutMs: 12000,
      now
    });
    const fingerprint = searchConfigurationFingerprint(search);
    const importedJobs = (Array.isArray(imported.jobs) && imported.jobs.length ? imported.jobs : [imported.job])
      .filter(Boolean)
      .map(job => ({ ...job, search_configuration_fingerprint: fingerprint }));
    const existing = readJSON(dataPath('job_leads.json'), []);
    const merged = mergeJobRecords(Array.isArray(existing) ? existing : [], importedJobs, { now });
    const runsValue = readJSON(dataPath('search_runs.json'), []);
    const runs = Array.isArray(runsValue) ? runsValue : (Array.isArray(runsValue?.runs) ? runsValue.runs : []);
    const run = {
      run_id: `user_url_${Date.parse(now) || Date.now()}`,
      search_configuration_fingerprint: fingerprint,
      search_profile_id: active?.id || '',
      status: 'completed',
      started_at: now,
      completed_at: now,
      provider: 'user_supplied_url',
      detected_provider: imported.provider.provider,
      provider_reachable: true,
      discovered_urls_count: importedJobs.length,
      deduped_jobs_count: merged.jobs.length,
      duplicates_merged: merged.duplicates_merged,
      mode: importedJobs.length > 1 ? 'explicit_public_career_url_import' : 'explicit_public_url_import',
      network_accessed: imported.loopback !== true
    };
    const backups = [backupFile(dataPath('job_leads.json')), backupFile(dataPath('search_runs.json'))];
    writeJSON(dataPath('job_leads.json'), merged.jobs);
    writeJSON(dataPath('search_runs.json'), [...runs, run].slice(-100));
    const result = {
      status: 'completed', run_type: 'job-url-import',
      message: scoredAgainstPreferences
        ? `${importedJobs.length} public job record${importedJobs.length === 1 ? '' : 's'} imported. Run scoring to see the matches.`
        : `${importedJobs.length} public job record${importedJobs.length === 1 ? '' : 's'} imported. Add a target role in your profile to see how well it matches.`,
      scored_against_preferences: scoredAgainstPreferences,
      job: importedJobs[0], jobs: importedJobs, provider: imported.provider, duplicates_merged: merged.duplicates_merged,
      discovered_urls_count: importedJobs.length, deduped_jobs_count: merged.jobs.length,
      files_touched: ['data/job_leads.json', 'data/search_runs.json'], backups,
      safety: imported.safety
    };
    const state = getDashboardState();
    state.last_run = result;
    state.run_history.push(result);
    state.run_history = state.run_history.slice(-25);
    writeJSON(dataPath('dashboard_state.json'), state);
    return sendJSON(res, result);
  } catch (error) {
    if (error instanceof JobUrlIngestionError) {
      return sendJSON(res, {
        status: 'blocked', code: error.code, message: error.message,
        ...(error.classification ? { classification: error.classification } : {}),
        ...(error.quality_gate ? { quality_gate: error.quality_gate } : {})
      }, error.status);
    }
    throw error;
  }
}

// One entry point for the jobs-page input box: classify first, then route to
// the right existing path. This is exactly what stops a BOSS list page from
// being fetched as a single job.
async function handleUnifiedJobImport(req, res) {
  let body = {};
  try { body = await readRequestBody(req, { maxBytes: 16 * 1024 }); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_IMPORT_REQUEST', message: error.message }, 400); }
  const input = String(body.input || body.url || '').trim();
  if (!input) return sendJSON(res, { status: 'error', code: 'EMPTY_INPUT', message: 'Paste a job link, a company careers link, or a job-board link.' }, 400);
  const classification = classifyJobInput(input);
  const publicClassification = {
    kind: classification.kind,
    browser_required: classification.browser_required === true,
    provider_hint: classification.provider_hint || '',
  };
  if (classification.kind === 'search_query') {
    return sendJSON(res, {
      status: 'not_a_url', classification: publicClassification,
      message: 'This looks like search keywords, not a link. Use the keyword search box instead.'
    });
  }
  if (classification.kind === 'job_board_url') {
    return sendJSON(res, {
      status: 'browser_required', classification: publicClassification,
      message: 'This is a job-board page. Jobs on it can only be read in a real browser session that you drive.'
    });
  }
  if (classification.kind === 'company_careers_url') {
    const imported = await internalCall(handleImportCompanyCareers, {
      url: classification.url, confirmed_public_fetch: true, import: true
    });
    return sendJSON(res, {
      ...imported.value, classification: publicClassification,
    }, imported.status);
  }
  const imported = await internalCall(handleImportJobUrl, {
    url: classification.url, confirmed_public_fetch: true
  });
  if (imported.status >= 400 && imported.value?.code === 'BROWSER_REQUIRED') {
    return sendJSON(res, {
      status: 'browser_required',
      classification: { ...publicClassification, browser_required: true },
      message: 'This site only shows the job in a real browser session. Open it there and complete any sign-in yourself.'
    });
  }
  if (imported.status >= 400
    && ['JOB_PAGE_FETCH_FAILED', 'JOB_PAGE_HTTP_ERROR', 'JOB_PAGE_TIMEOUT'].includes(String(imported.value?.code || ''))) {
    // Company sites that merely WRAP a Greenhouse posting (jobs.dropbox.com
    // /listing/…?gh_jid=N) often block plain fetches, while the
    // Greenhouse-hosted page of the SAME posting stays public. Verify there
    // instead of dead-ending both the one-click verify and the paste box.
    for (const fallbackUrl of greenhouseFallbackUrls(classification.url)) {
      const retried = await internalCall(handleImportJobUrl, { url: fallbackUrl, confirmed_public_fetch: true });
      if (retried.status < 400) {
        return sendJSON(res, {
          ...retried.value,
          classification: publicClassification,
          fallback_source: 'greenhouse_hosted_page',
        }, retried.status);
      }
    }
  }
  return sendJSON(res, { ...imported.value, classification: publicClassification }, imported.status);
}

// A gh_jid query parameter marks a Greenhouse-backed posting; candidate board
// tokens come from the matching inventory record's company name and from the
// wrapping site's second-level domain (jobs.dropbox.com → dropbox).
function greenhouseFallbackUrls(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const ghJid = url.searchParams.get('gh_jid') || '';
    if (!/^\d+$/.test(ghJid)) return [];
    if (/greenhouse\.io$/i.test(url.hostname)) return [];
    const tokens = new Set();
    const jobs = readJSON(dataPath('job_leads.json'), []);
    const record = (Array.isArray(jobs) ? jobs : []).find(job =>
      [job.canonical_url, job.url].map(value => String(value || '')).includes(url.href));
    const companySlug = String(record?.company || '').trim().toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '');
    if (companySlug) tokens.add(companySlug);
    const hostParts = url.hostname.split('.');
    if (hostParts.length >= 2) tokens.add(hostParts[hostParts.length - 2].toLocaleLowerCase('en-US'));
    return [...tokens].filter(Boolean).map(token => `https://boards.greenhouse.io/${token}/jobs/${ghJid}`);
  } catch {
    return [];
  }
}

// Keyword search over the REAL discovery providers, in priority order:
//   1. company careers boards already known to this workspace (official APIs)
//   2. SearXNG, when configured and READY (never blocks anything when down)
// With no source available the answer is honest: no sources — not a blank list.
const CAREERS_BOARD_ROOTS = [
  { host: 'jobs.lever.co', root: url => `https://jobs.lever.co/${url.pathname.split('/').filter(Boolean)[0] || ''}` },
  { host: 'greenhouse.io', root: url => {
    const segment = url.hostname.endsWith('greenhouse.io') ? url.pathname.split('/').filter(Boolean)[0] : '';
    return segment ? `https://boards.greenhouse.io/${segment}` : '';
  } },
  { host: 'jobs.ashbyhq.com', root: url => `https://jobs.ashbyhq.com/${url.pathname.split('/').filter(Boolean)[0] || ''}` },
  { host: 'jobs.smartrecruiters.com', root: url => `https://jobs.smartrecruiters.com/${url.pathname.split('/').filter(Boolean)[0] || ''}` },
  { host: 'apply.workable.com', root: url => `https://apply.workable.com/${url.pathname.split('/').filter(Boolean)[0] || ''}` },
];

function knownCareersBoards(limit = 5) {
  const boards = new Set();
  for (const job of getAllJobRecords()) {
    const target = String(job.canonical_url || job.url || job.apply_url || '');
    let url;
    try { url = new URL(target); } catch { continue; }
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const entry of CAREERS_BOARD_ROOTS) {
      if (hostname !== entry.host && !hostname.endsWith(`.${entry.host}`)) continue;
      const root = entry.root(url);
      if (root && !root.endsWith('/')) boards.add(root);
    }
    if (boards.size >= limit) break;
  }
  return [...boards].slice(0, limit);
}

function keywordMatches(query, ...haystacks) {
  const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const text = haystacks.join(' ').toLowerCase();
  return tokens.every(token => text.includes(token));
}

async function handleJobKeywordSearch(req, res) {
  let body = {};
  try { body = await readRequestBody(req, { maxBytes: 8 * 1024 }); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_SEARCH_REQUEST', message: error.message }, 400); }
  const query = String(body.query || '').trim();
  if (query.length < 1 || query.length > 200) {
    return sendJSON(res, { status: 'error', code: 'INVALID_SEARCH_QUERY', message: 'Enter search keywords (1–200 characters).' }, 400);
  }
  const now = new Date().toISOString();
  const sourcesUsed = [];
  const found = [];

  // 1. Company careers boards already known to this workspace.
  for (const board of knownCareersBoards()) {
    try {
      const discovered = await discoverCompanyJobs(board, { timeoutMs: 8000 });
      const postings = (discovered.jobs || [])
        .filter(job => keywordMatches(query, job.title || '', job.location || '', job.description_text || ''))
        .slice(0, 10);
      sourcesUsed.push({ source: 'company_careers', board, status: discovered.status || 'ok', matched: postings.length });
      for (const posting of postings) {
        found.push({
          ...posting,
          source: 'user_supplied_career_url',
          discovery: { discovered_by: 'keyword_search', query, discovered_at: now, original_url: posting.apply_url || board },
          search_query: query, imported_at: now,
        });
      }
    } catch (error) {
      sourcesUsed.push({ source: 'company_careers', board, status: 'provider_unreachable', matched: 0 });
    }
    if (found.length >= 20) break;
  }

  // 2. SearXNG when READY. A stopped SearXNG never blocks: state gate + short
  // timeout + per-result error isolation.
  const searchSources = normalizeJobSearchSources(readJSON(dataPath('job_sources.json'), {}));
  const searxng = searchSources.search_backends?.[SEARXNG_PROVIDER_ID] || {};
  if (searxng.enabled === true && searxng.status === 'READY' && searxng.url) {
    try {
      const results = await searchSearxng(`${query} job OR 招聘`, {
        searxngUrl: searxng.url, maxResults: 6, maxPages: 2, timeoutMs: Math.min(10000, Number(searxng.timeout_ms) || 8000)
      });
      let imported = 0;
      for (const result of results) {
        const kind = classifyJobInput(result.url);
        if (kind.kind !== 'single_job_url' || kind.browser_required) continue;
        try {
          const ingested = await ingestPublicJobUrl(result.url, { confirmedPublicFetch: true, timeoutMs: 8000, now });
          for (const job of ingested.jobs) {
            found.push({
              ...job,
              discovery: { discovered_by: 'keyword_search', query, discovered_at: now, original_url: result.url },
              search_query: query,
            });
            imported += 1;
          }
        } catch { /* one bad result must not sink the search */ }
        if (found.length >= 25) break;
      }
      sourcesUsed.push({ source: 'searxng', status: 'ok', matched: imported });
    } catch {
      sourcesUsed.push({ source: 'searxng', status: 'provider_unreachable', matched: 0 });
    }
  } else {
    sourcesUsed.push({ source: 'searxng', status: searxng.enabled === true ? (searxng.status || 'ERROR') : 'DISABLED', matched: 0 });
  }

  const usable = sourcesUsed.filter(item => !['DISABLED', 'MISCONFIGURED', 'provider_unreachable'].includes(item.status));
  if (!usable.length) {
    return sendJSON(res, {
      status: 'no_sources', query, sources: sourcesUsed, found: 0, imported: 0,
      message: 'No search source is available right now. Paste a job link or a company careers link instead, or configure SearXNG in the classic UI.'
    });
  }

  const gated = found.filter(job => jobQualityGate({ ...job, company: job.company || 'pending' }).ok);
  let merged = { jobs: [], duplicates_merged: 0 };
  if (gated.length) {
    const search = normalizeSearchPreferences(readJSON(dataPath('search_preferences.json'), defaultSearchPreferences())).value;
    const fingerprint = searchConfigurationFingerprint(search);
    const records = gated
      .map(job => normalizeJobRecord({ ...job, search_configuration_fingerprint: fingerprint }, { now, defaultSource: job.source || 'searxng_public_search' }))
      .filter(Boolean);
    const existing = readJSON(dataPath('job_leads.json'), []);
    merged = mergeJobRecords(Array.isArray(existing) ? existing : [], records, { now });
    backupFile(dataPath('job_leads.json'));
    writeJSON(dataPath('job_leads.json'), merged.jobs);
  }
  return sendJSON(res, {
    status: 'ok', query, sources: sourcesUsed,
    found: gated.length, imported: gated.length, duplicates_merged: merged.duplicates_merged,
    jobs: gated.slice(0, 10).map(job => ({ title: job.title, company: job.company, location: job.location || '' })),
    safety: { network_accessed: true, application_page_opened_in_browser: false, resume_uploaded: false, application_submitted: false }
  });
}

// Assisted browser reading of a job board (LinkedIn, BOSS 直聘…). The user
// drives the opened window — sign-in, verification, search — and the watcher
// only reads the job links that become visible. One discovery at a time.
let assistedDiscovery = null;

async function handleDiscoverInBrowser(req, res) {
  let body = {};
  try { body = await readRequestBody(req, { maxBytes: 8 * 1024 }); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_DISCOVERY_REQUEST', message: error.message }, 400); }
  if (body.confirmed !== true) {
    return sendJSON(res, {
      status: 'blocked', code: 'DISCOVERY_CONFIRMATION_REQUIRED',
      message: 'confirmed=true is required: a visible browser window will open and you drive it yourself.'
    }, 409);
  }
  // Search mode: a board adapter (boss/linkedin) builds the site's normal
  // public search URL from a keyword; watch mode opens the URL as given.
  const registryBoards = Object.fromEntries(browserAdapters().map(adapter => [adapter.id.replace(/^browser_/, ''), adapter]));
  const boardKind = Object.hasOwn(registryBoards, String(body.board || '')) ? String(body.board) : '';
  const keyword = String(body.keyword || '').trim().slice(0, 100);
  const searchMode = Boolean(boardKind && keyword);
  const targetUrl = searchMode
    ? registryBoards[boardKind].browser.search_url(keyword, String(body.city || '').slice(0, 80))
    : String(body.url || '');
  const classification = classifyJobInput(targetUrl);
  if (!['job_board_url', 'company_careers_url', 'single_job_url'].includes(classification.kind)) {
    return sendJSON(res, { status: 'error', code: 'INVALID_DISCOVERY_URL', message: 'Enter the job-board or careers URL to open, or a board plus a keyword.' }, 400);
  }
  if (assistedDiscovery && assistedDiscovery.child?.exitCode === null) {
    return sendJSON(res, {
      status: 'busy', code: 'DISCOVERY_ALREADY_RUNNING',
      message: 'A browser reading session is already open. Finish or close it first.'
    }, 409);
  }
  const discoveryId = `discover_${Date.now().toString(36)}`;
  const discoveryDir = path.join(BROWSER_SESSIONS_DIR, 'assisted-discovery');
  fs.mkdirSync(discoveryDir, { recursive: true });
  const outFile = path.join(discoveryDir, `${discoveryId}.json`);
  const logFile = path.join(discoveryDir, `${discoveryId}.log`);
  const descriptor = fs.openSync(logFile, 'a');
  const args = [
    path.join(PROJECT_ROOT, 'browser_agent', 'discover_jobs.mjs'),
    '--url', classification.url,
    '--out', outFile,
    '--profile-dir', path.join(BROWSER_PROFILES_DIR, 'resume-jobs-agent'),
    ...(searchMode ? ['--mode', 'search', '--board', boardKind, '--keyword', keyword, ...(body.city ? ['--city', String(body.city).slice(0, 80)] : [])] : []),
  ];
  if (process.env.RESUME_JOBS_BROWSER_AGENT_TEST_MODE === '1' && (() => {
    try { return ['127.0.0.1', 'localhost'].includes(new URL(classification.url).hostname); } catch { return false; }
  })()) args.push('--headless-test', '--max-wait-ms', '30000');
  const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, windowsHide: true, stdio: ['ignore', descriptor, descriptor] });
  child.once('close', () => { try { fs.closeSync(descriptor); } catch { /* already closed */ } });
  assistedDiscovery = { discovery_id: discoveryId, url: classification.url, out_file: outFile, child, imported: false, started_at: new Date().toISOString() };
  return sendJSON(res, {
    status: 'ok', discovery_id: discoveryId, classification: { kind: classification.kind, browser_required: classification.browser_required === true },
    message: 'A browser window opened. Sign in or search there yourself; jobs it shows are read automatically.',
    safety: { login_attempted: false, challenge_bypassed: false, application_submitted: false }
  });
}

// "I finished signing in — continue now": drops a signal file the watcher
// consumes on its next tick to rescan and resume immediately, WITHOUT any
// reload or navigation of the page the user just worked on.
function handleDiscoverInBrowserContinue(res) {
  if (!assistedDiscovery || assistedDiscovery.child?.exitCode !== null) {
    return sendJSON(res, { status: 'error', code: 'NO_DISCOVERY_RUNNING', message: 'No browser reading session is open right now.' }, 409);
  }
  try {
    fs.writeFileSync(`${assistedDiscovery.out_file}.continue`, `${new Date().toISOString()}\n`);
  } catch (error) {
    return sendJSON(res, { status: 'error', code: 'CONTINUE_SIGNAL_FAILED', message: String(error.message || error) }, 500);
  }
  return sendJSON(res, { status: 'ok', message: 'Continuing — the page is read again right away, without reloading it.' });
}

function handleDiscoverInBrowserStatus(res) {
  if (!assistedDiscovery) {
    return sendJSON(res, { status: 'idle', message: 'No browser reading session has been started.' });
  }
  let report = null;
  try { report = JSON.parse(fs.readFileSync(assistedDiscovery.out_file, 'utf8')); }
  catch { /* the watcher has not written yet */ }
  // Alive means the child claims to run AND its heartbeat (the report file it
  // rewrites every ~2s) is fresh. A dead-but-unreaped watcher must never be
  // reported as a healthy running session.
  const heartbeatAge = report?.updated_at ? Date.now() - Date.parse(report.updated_at) : null;
  const heartbeatStale = Number.isFinite(heartbeatAge) && heartbeatAge > 45_000;
  const running = assistedDiscovery.child?.exitCode === null && !heartbeatStale;
  const jobs = Array.isArray(report?.jobs) ? report.jobs : [];
  // Import once, when the watcher finished. Every job passes the quality gate
  // and carries full provenance; the canonical-URL merge keeps out duplicates.
  let imported = 0;
  let duplicatesMerged = 0;
  if (!running && jobs.length && !assistedDiscovery.imported) {
    const now = new Date().toISOString();
    const records = jobs
      .filter(job => jobQualityGate({ ...job, company: job.company || 'pending' }).ok)
      .map(job => normalizeJobRecord({
        ...job,
        source: 'assisted_browser_discovery',
        discovery: { discovered_by: 'assisted_browser', query: '', discovered_at: now, original_url: assistedDiscovery.url },
        imported_at: now,
      }, { now, defaultSource: 'assisted_browser_discovery' }))
      .filter(Boolean);
    if (records.length) {
      const existing = readJSON(dataPath('job_leads.json'), []);
      const merged = mergeJobRecords(Array.isArray(existing) ? existing : [], records, { now });
      backupFile(dataPath('job_leads.json'));
      writeJSON(dataPath('job_leads.json'), merged.jobs);
      imported = records.length;
      duplicatesMerged = merged.duplicates_merged;
    }
    assistedDiscovery.imported = true;
    assistedDiscovery.imported_count = imported;
  }
  return sendJSON(res, {
    status: running ? 'running' : (heartbeatStale && assistedDiscovery.child?.exitCode === null ? 'stalled' : (report?.status || 'completed')),
    discovery_id: assistedDiscovery.discovery_id,
    board_url: assistedDiscovery.url,
    diagnostics: report?.diagnostics || null,
    note: report?.note || '',
    found: jobs.length,
    imported: assistedDiscovery.imported ? (assistedDiscovery.imported_count || 0) : imported,
    duplicates_merged: duplicatesMerged,
    jobs: jobs.slice(0, 15).map(job => ({ title: job.title, company: job.company || '' })),
    user_action: report?.user_action || { waiting_for_user: false, reason: '', message: '' },
    safety: report?.safety || { user_drives_the_page: true, login_attempted: false, challenge_bypassed: false, application_submitted: false }
  });
}

// === Global Job Search Engine =============================================

function readSearchPlanStore() {
  return normalizeSearchPlanStore(readJSON(dataPath('search_plans.json'), {}));
}
function writeSearchPlanStore(store) {
  backupFile(dataPath('search_plans.json'));
  writePrivateJSON(dataPath('search_plans.json'), store);
}

function handleListSearchPlans(res) {
  const store = readSearchPlanStore();
  const profile = activeCareerProfileRecord();
  const currentDigest = careerProfileDigest(profile);
  const currentVersion = profile?.version ?? null;
  // A profile-generated plan is stale once the profile's search-driving content
  // changed (digest mismatch). Manually built plans are never auto-stale.
  const plans = store.plans.map(plan => ({
    ...plan,
    stale: plan.generated_from_profile === true && Boolean(plan.profile_digest) && plan.profile_digest !== currentDigest,
  }));
  sendJSON(res, { status: 'ok', ...store, plans, current_profile_version: currentVersion, current_profile_digest: currentDigest });
}

// Stable digest of the parts of a Career Profile that drive search directions.
// A new profile version that changes any of these makes profile-bound search
// plans stale.
function careerProfileDigest(profile) {
  if (!profile) return '';
  const material = JSON.stringify({
    education: profile.education || [],
    experience: (profile.experience || []).map(e => ({ role: e.role, company: e.company, responsibilities: e.responsibilities, technologies: e.technologies, achievements: e.achievements })),
    projects: (profile.projects || []).map(p => ({ name: p.name, description: p.description, technologies: p.technologies, results: p.results })),
    skills: profile.skills || {},
    career_goals: profile.career_goals || [],
    job_preferences: profile.job_preferences || {},
  });
  return sha256Of(material).slice(0, 23); // "sha256:" + 16 hex
}

function activeCareerProfileRecord() {
  const careerBrain = readCareerBrainStore();
  return careerBrain.profiles.find(p => p.id === careerBrain.active_profile_id)
    || careerBrain.profiles.find(p => p.user_approved === true)
    || careerBrain.profiles[0] || null;
}

// What the system would search for, derived from the approved Career Profile —
// shown to the user (and editable) BEFORE any search runs. Read-only.
function handleProfileDirections(res) {
  const profile = activeCareerProfileRecord();
  if (!profile) {
    return sendJSON(res, { status: 'no_profile', available: false, message: 'No Career Profile yet. Add your resume first.' });
  }
  const queries = buildSearchQueries({ careerProfile: profile, criteria: {} });
  const roles = deriveRoles(profile);
  sendJSON(res, {
    status: 'ok',
    available: roles.length > 0 || queries.roles.length > 0,
    profile_name: profile.name || '',
    profile_approved: profile.user_approved === true,
    profile_version: profile.version ?? null,
    profile_digest: careerProfileDigest(profile),
    roles: queries.roles,
    adjacent_roles: roles.filter(role => !queries.roles.includes(role)).slice(0, 8),
    locations: profileLocations(profile).slice(0, 8),
    keywords: queries.text_queries.slice(0, 12).map(item => item.query),
    skills: extractSkills(profile).slice(0, 20),
    entry_level: queries.entry_level === true,
  });
}

async function handleSaveSearchPlan(req, res) {
  let body = {};
  try { body = await readRequestBody(req, { maxBytes: 64 * 1024 }); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_SEARCH_PLAN', message: error.message }, 400); }
  const { store, plan } = upsertSearchPlan(readSearchPlanStore(), body);
  if (body.activate === true || !store.active_plan_id) store.active_plan_id = plan.plan_id;
  writeSearchPlanStore(store);
  sendJSON(res, { status: 'ok', plan, active_plan_id: store.active_plan_id, total: store.plans.length });
}

function handleDeleteSearchPlan(res, planId) {
  const store = deleteSearchPlan(readSearchPlanStore(), planId);
  writeSearchPlanStore(store);
  sendJSON(res, { status: 'ok', total: store.plans.length, active_plan_id: store.active_plan_id });
}

// One run at a time; progress is polled. Providers report independently and
// the pipeline is always gate -> dedup -> filter (why_filtered) -> match.
let globalSearchRun = null;

async function searxngRuntimeState() {
  const configured = normalizeJobSearchSources(readJSON(dataPath('job_sources.json'), {}));
  const backend = configured.search_backends?.[SEARXNG_PROVIDER_ID] || {};
  const url = backend.url || 'http://127.0.0.1:8888/search';
  // Live probe: READY means actually answering right now, not a stale flag.
  try {
    const probe = new URL(url);
    probe.searchParams.set('q', 'ping');
    probe.searchParams.set('format', 'json');
    const response = await fetch(probe, { signal: AbortSignal.timeout(2500) });
    if (response.ok) return { enabled: true, url, status: 'READY', timeout_ms: backend.timeout_ms || 9000, engines: 'bing' };
    return { enabled: false, url, status: `HTTP_${response.status}` };
  } catch {
    return { enabled: false, url, status: 'UNREACHABLE' };
  }
}

async function handleRunGlobalSearch(req, res) {
  let body = {};
  try { body = await readRequestBody(req, { maxBytes: 64 * 1024 }); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_SEARCH_REQUEST', message: error.message }, 400); }
  if (globalSearchRun && globalSearchRun.status === 'running') {
    return sendJSON(res, { status: 'busy', code: 'SEARCH_ALREADY_RUNNING', message: 'A search is already running. Watch its progress or wait for it to finish.' }, 409);
  }
  const planStore = readSearchPlanStore();
  const plan = planStore.plans.find(item => item.plan_id === String(body.plan_id || planStore.active_plan_id))
    || (body.criteria ? { plan_id: '', name: 'ad-hoc', criteria: normalizeSearchCriteria(body.criteria) } : null);
  if (!plan) {
    return sendJSON(res, { status: 'error', code: 'SEARCH_PLAN_NOT_FOUND', message: 'Save a search plan first, or send criteria directly.' }, 404);
  }
  const careerStore = readCareerBrainStore();
  const careerProfile = careerStore.profiles.find(item => item.id === careerStore.active_profile_id) || {};
  const searxng = await searxngRuntimeState();
  const runId = `search_${Date.now().toString(36)}`;
  globalSearchRun = {
    run_id: runId, plan_id: plan.plan_id, plan_name: plan.name, status: 'running',
    started_at: new Date().toISOString(), providers: [], searxng_status: searxng.status,
  };
  sendJSON(res, { status: 'ok', run_id: runId, plan: { plan_id: plan.plan_id, name: plan.name }, searxng: searxng.status });

  // The run continues after the response; status is polled.
  (async () => {
    const run = globalSearchRun;
    try {
      const outcome = await runGlobalSearch({
        criteria: plan.criteria,
        careerProfile,
        inventoryBoards: knownCareersBoards(8),
        searxng,
        onProgress: progress => { run.providers = progress.providers; },
        shouldStop: () => run.stop_requested === true,
      });
      run.providers = outcome.providers;
      run.queries = { roles: outcome.queries.roles, text: outcome.queries.text_queries.length, site: outcome.queries.site_queries.length };
      const now = new Date().toISOString();

      // Dedup BEFORE filtering so counts are honest per unique job.
      const normalized = outcome.jobs
        .map(job => normalizeJobRecord({ ...job, imported_at: now }, { now, defaultSource: job.source || 'user_supplied_career_url' }))
        .filter(Boolean);
      const uniqueByUrl = [...new Map(normalized.map(job => [job.canonical_url, job])).values()];

      // Filter Engine, with why_filtered kept for the UI.
      const { accepted, filtered } = filterJobs(uniqueByUrl, plan.criteria);

      // Matching on survivors, plus the plan minimum-score threshold.
      const context = matchingContextFromCareerProfile(careerProfile);
      const scored = [];
      const belowThreshold = [];
      for (const job of accepted) {
        const match = scoreJobForSearch(job, context, {
          preferredLocations: plan.criteria.locations || [],
          minimumSalary: plan.criteria.salary_min || null,
        });
        // Soft preferences lower the ranking without removing the job.
        const softPenalties = Array.isArray(job.soft_penalties) ? job.soft_penalties : [];
        const adjustedScore = match.match_score == null
          ? null
          : Math.max(0, match.match_score - softPenalties.length * 7);
        const decorated = {
          ...job,
          soft_penalties: undefined,
          match_score: adjustedScore ?? job.match_score,
          search_match: {
            match_score: adjustedScore, why_fit: match.why_fit, main_gaps: match.main_gaps,
            soft_notes: softPenalties.map(item => `${item.rule}: ${item.detail ?? ''}`.trim()),
            plan_id: plan.plan_id, scored_at: now,
          },
        };
        if (plan.criteria.minimum_match_score != null && adjustedScore != null
          && adjustedScore < plan.criteria.minimum_match_score) {
          belowThreshold.push({ job: decorated, why_filtered: [{ rule: 'below_minimum_match_score', detail: String(adjustedScore) }] });
        } else {
          scored.push(decorated);
        }
      }

      // Merge survivors into the inventory (canonical dedup, source history).
      let merged = { jobs: readJSON(dataPath('job_leads.json'), []), duplicates_merged: 0 };
      if (scored.length) {
        const existing = readJSON(dataPath('job_leads.json'), []);
        merged = mergeJobRecords(Array.isArray(existing) ? existing : [], scored, { now });
        backupFile(dataPath('job_leads.json'));
        writeJSON(dataPath('job_leads.json'), merged.jobs);
      }

      // Re-score the WHOLE inventory with the current profile and scoring
      // rules. Scores are stored at import time, so without this a job
      // imported by an earlier run keeps its stale number forever — the user
      // re-runs the search and "nothing changes". Scores only: nothing is
      // ever deleted or re-filtered here.
      let inventoryRescored = 0;
      {
        const inventory = readJSON(dataPath('job_leads.json'), []);
        if (Array.isArray(inventory) && inventory.length) {
          if (!scored.length) backupFile(dataPath('job_leads.json'));
          for (const job of inventory) {
            const match = scoreJobForSearch(job, context, {
              preferredLocations: plan.criteria.locations || [],
              minimumSalary: plan.criteria.salary_min || null,
            });
            if (match.match_score == null) continue;
            const softNotes = Array.isArray(job.search_match?.soft_notes) ? job.search_match.soft_notes : [];
            const adjusted = Math.max(0, match.match_score - softNotes.length * 7);
            job.match_score = adjusted;
            job.search_match = {
              ...(job.search_match || {}),
              match_score: adjusted, why_fit: match.why_fit, main_gaps: match.main_gaps,
              plan_id: plan.plan_id, scored_at: now,
            };
            // A stale legacy combined score would shadow the fresh number in
            // the UI (it renders combined_score ?? match_score).
            if (job.match_scores && typeof job.match_scores === 'object') {
              job.match_scores = { ...job.match_scores, combined_score: adjusted };
            }
            inventoryRescored += 1;
          }
          writeJSON(dataPath('job_leads.json'), inventory);
        }
      }

      const filteredOut = [...filtered, ...belowThreshold].map(item => ({
        title: item.job.title, company: item.job.company, location: item.job.location || '',
        why_filtered: item.why_filtered,
      }));
      run.status = 'completed';
      run.completed_at = new Date().toISOString();
      run.summary = {
        raw_found: outcome.raw_found,
        gated_out: outcome.gated_out,
        unique_after_dedup: uniqueByUrl.length,
        duplicates_merged_in_run: normalized.length - uniqueByUrl.length,
        filtered_out: filteredOut.length,
        accepted: scored.length,
        recommended: scored.filter(job => (job.match_score ?? 0) >= 60).length,
        merged_into_inventory: scored.length,
        inventory_duplicates_merged: merged.duplicates_merged,
        inventory_rescored: inventoryRescored,
        limited_access: (outcome.limited_access || []).length,
      };
      run.filtered = filteredOut.slice(0, 100);
      run.limited_access = (outcome.limited_access || []).slice(0, 50);
      run.top_jobs = scored
        .sort((left, right) => (right.match_score ?? -1) - (left.match_score ?? -1))
        .slice(0, 15)
        .map(job => ({ title: job.title, company: job.company, location: job.location || '', match_score: job.match_score ?? null }));

      const updatedStore = readSearchPlanStore();
      if (plan.plan_id) {
        const saved = upsertSearchPlan(updatedStore, { ...plan, last_run_at: run.completed_at, last_run_summary: run.summary });
        writeSearchPlanStore(saved.store);
      }
    } catch (error) {
      run.status = 'failed';
      run.error = String(error?.message || error).slice(0, 300);
    }
  })();
}


// User flags on a job: shortlist membership, the permanent ignore, and
// blocking the whole company (which also feeds the active search plan's
// blocked list so future searches skip it).
async function handleJobFlag(req, res, jobId) {
  let body = {};
  try { body = await readRequestBody(req, { maxBytes: 8 * 1024 }); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_FLAG_REQUEST', message: error.message }, 400); }
  const action = String(body.action || '').trim();
  const allowed = ['shortlist', 'unshortlist', 'save', 'unsave', 'ignore_forever', 'unignore', 'block_company'];
  if (!allowed.includes(action)) {
    return sendJSON(res, { status: 'error', code: 'UNSUPPORTED_FLAG_ACTION', message: `action must be one of: ${allowed.join(', ')}` }, 400);
  }
  // A job can live in job_leads.json, jobs_shortlist.json, or both (the apply
  // flow copies the record into the shortlist file). Flags must be written to
  // EVERY copy — the read path merges shortlist over leads, so a stale copy in
  // one file would silently win over the other after the next merge.
  const files = [dataPath('job_leads.json'), dataPath('jobs_shortlist.json')]
    .map(filePath => ({ filePath, jobs: readJSON(filePath, []) }))
    .map(entry => ({ ...entry, jobs: Array.isArray(entry.jobs) ? entry.jobs : [] }));
  const holders = files
    .map(entry => ({ ...entry, job: entry.jobs.find(job => String(job.job_id) === String(jobId)) }))
    .filter(entry => entry.job);
  if (!holders.length) return sendJSON(res, { status: 'error', code: 'JOB_NOT_FOUND', message: 'Job not found' }, 404);
  const applyFlag = job => {
    if (action === 'shortlist') job.shortlisted = true;
    if (action === 'unshortlist') delete job.shortlisted;
    if (action === 'save') job.saved = true;
    if (action === 'unsave') delete job.saved;
    if (action === 'ignore_forever') job.ignored_forever = true;
    if (action === 'unignore') delete job.ignored_forever;
  };
  let blockedCompany = '';
  if (action === 'block_company') {
    blockedCompany = String(holders[0].job.company || '').trim();
    if (!blockedCompany) return sendJSON(res, { status: 'error', code: 'COMPANY_UNKNOWN', message: 'This job has no company name to block.' }, 409);
    for (const entry of files) {
      for (const record of entry.jobs) {
        if (String(record.company || '').trim().toLocaleLowerCase('en-US') === blockedCompany.toLocaleLowerCase('en-US')) {
          record.ignored_forever = true;
        }
      }
    }
    const planStore = readSearchPlanStore();
    const activePlan = planStore.plans.find(item => item.plan_id === planStore.active_plan_id);
    if (activePlan && !activePlan.criteria.blocked_companies.some(name => name.toLocaleLowerCase('en-US') === blockedCompany.toLocaleLowerCase('en-US'))) {
      activePlan.criteria.blocked_companies.push(blockedCompany);
      const savedStore = upsertSearchPlan(planStore, activePlan);
      writeSearchPlanStore(savedStore.store);
    }
  } else {
    for (const entry of holders) applyFlag(entry.job);
  }
  for (const entry of files) {
    if (action !== 'block_company' && !holders.some(holder => holder.filePath === entry.filePath)) continue;
    backupFile(entry.filePath);
    writeJSON(entry.filePath, entry.jobs);
  }
  const job = holders[0].job;
  sendJSON(res, {
    status: 'ok', job_id: String(jobId), action,
    shortlisted: job.shortlisted === true, saved: job.saved === true, ignored_forever: job.ignored_forever === true,
    ...(blockedCompany ? { blocked_company: blockedCompany } : {}),
  });
}

// Persist the durable saved flag on every stored copy of a job record.
// Application-status transitions call this so that approving or applying a
// saved job never erases the user's 收藏 mark.
function setJobSavedFlag(jobId, saved) {
  for (const filePath of [dataPath('job_leads.json'), dataPath('jobs_shortlist.json')]) {
    const jobs = readJSON(filePath, []);
    if (!Array.isArray(jobs)) continue;
    const job = jobs.find(item => String(item.job_id) === String(jobId));
    if (!job) continue;
    if (saved) {
      if (job.saved === true) continue;
      job.saved = true;
    } else {
      if (job.saved !== true) continue;
      delete job.saved;
    }
    backupFile(filePath);
    writeJSON(filePath, jobs);
  }
}

function handleGlobalSearchStatus(res) {
  if (!globalSearchRun) return sendJSON(res, { status: 'idle', capabilities: capabilityReport() });
  sendJSON(res, { status: 'ok', run: globalSearchRun, capabilities: capabilityReport() });
}

function handleStopGlobalSearch(res) {
  if (!globalSearchRun || globalSearchRun.status !== 'running') {
    return sendJSON(res, { status: 'ok', message: 'No search is running.' });
  }
  globalSearchRun.stop_requested = true;
  sendJSON(res, { status: 'ok', run_id: globalSearchRun.run_id, message: 'Stopping after the current source finishes.' });
}

function handleOfflineDemoDiscovery(res) {
  const search = normalizeSearchPreferences(readJSON(dataPath('search_preferences.json'), defaultSearchPreferences())).value;
  const active = search.search_profiles.find(profile => profile.id === search.active_search_profile_id) || null;
  if (!search.workflow_meta?.configured_at
    || !active
    || active.enabled === false
    || !active.target_roles?.some(item => item?.enabled !== false && String(item?.keyword || item || '').trim())) {
    return sendJSON(res, {
      status: 'blocked',
      run_type: 'offline-demo-discovery',
      ok: false,
      code: 'SEARCH_CONFIGURATION_REQUIRED',
      message: 'Save a target role in Job Search before using Offline Demo.'
    }, 409);
  }

  const existingLeads = readJSON(dataPath('job_leads.json'), []);
  const existingShortlist = readJSON(dataPath('jobs_shortlist.json'), []);
  const existingProductJobs = [...existingLeads, ...existingShortlist]
    .filter(job => !Array.isArray(job?.tags) || !job.tags.includes('offline_demo'));
  if (existingProductJobs.length) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'OFFLINE_DEMO_REQUIRES_EMPTY_JOB_LIBRARY',
      message: 'Offline Demo Jobs are available only before real or imported jobs exist. Existing jobs were preserved.'
    }, 409);
  }

  const now = new Date().toISOString();
  const demo = buildOfflineDemoDiscovery({
    searchPreferences: search,
    dashboardPort: PORT,
    now
  });
  const merged = mergeJobRecords(
    existingLeads.filter(job => Array.isArray(job?.tags) && job.tags.includes('offline_demo')),
    [demo.job],
    { now }
  );
  const searchRunsRaw = readJSON(dataPath('search_runs.json'), []);
  const searchRuns = Array.isArray(searchRunsRaw)
    ? searchRunsRaw
    : (Array.isArray(searchRunsRaw?.runs) ? searchRunsRaw.runs : []);

  writeJSON(dataPath('job_leads.json'), merged.jobs);
  writeJSON(dataPath('jobs_shortlist.json'), []);
  writeJSON(dataPath('search_runs.json'), [...searchRuns, demo.searchRun].slice(-100));
  writeJSON(dataPath('provider_health.json'), demo.providerHealth);

  const result = {
    status: 'completed',
    run_type: 'offline-demo-discovery',
    started_at: now,
    finished_at: now,
    code: 'OFFLINE_DEMO_READY',
    message: 'One synthetic localhost-only job is ready for scoring.',
    files_touched: [
      'data/job_leads.json',
      'data/jobs_shortlist.json',
      'data/search_runs.json',
      'data/provider_health.json'
    ],
    job_id: demo.job.job_id,
    safety: {
      network_accessed: false,
      real_site_opened: false,
      login_attempted: false,
      resume_uploaded: false,
      final_submit_clicked: false,
      synthetic_data_only: true,
      localhost_only: true
    }
  };
  const state = getDashboardState();
  state.last_run = result;
  state.run_history.push(result);
  state.run_history = state.run_history.slice(-25);
  writeJSON(dataPath('dashboard_state.json'), state);
  return sendJSON(res, result);
}

async function handleDecision(req, res, jobId, decision) {
  if (!VALID_DECISIONS.has(decision)) {
    return sendJSON(res, { status: 'error', message: 'Invalid decision' }, 400);
  }
  const job = findJob(jobId);
  if (!job) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);

  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  const requestedAction = decision === 'pending' ? 'restore' : decision;
  if (decision === 'reconsider' && body.confirmed !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'RECONSIDER_CONFIRMATION_REQUIRED',
      message: 'Confirm that you want to restore this rejected job and approve it.',
      current_state: currentStatusForJob(jobId),
      requested_action: 'reconsider_and_approve',
      allowed_actions: ['restore_to_review', 'reconsider_and_approve'],
      recommended_recovery_action: 'Review the job warning, then confirm reconsideration.'
    }, 409);
  }

  if (decision === 'approved' || decision === 'reconsider') {
    const pageType = job.page_type || 'unknown';
    const recommendedDecision = job.recommended_decision || 'manual_review';
    const eligibility = readJobApprovalEligibility({
      ...job,
      page_type: pageType,
      recommended_decision: recommendedDecision
    });
    const approvalSafety = eligibility.approval_safety;
    const safeToApprove = eligibility.safe_to_approve;
    if (!safeToApprove) {
      const blockers = approvalBlockersForJob(job, eligibility);
      return sendJSON(res, {
        status: 'blocked',
        code: 'JOB_APPROVAL_BLOCKED',
        message: blockers[0] || 'Approve blocked by safety rules.',
        blockers,
        current_state: currentStatusForJob(jobId),
        requested_action: requestedAction,
        allowed_actions: applicationAllowedTransitions(currentStatusForJob(jobId)),
        recommended_recovery_action: portalCapabilityForJob(job).action,
        job_id: String(jobId),
        page_type: pageType,
        approval_safety: approvalSafety,
        approval_safety_error: eligibility.error,
        approval_warning: job.approval_warning || 'Review only — not a confirmed job detail page.',
        recommended_decision: recommendedDecision,
        safety: {
          browser_opened: false,
          chrome_extension_called: false,
          apply_submit_clicked: false,
          resume_uploaded: false,
          application_submitted: false
        }
      }, 409);
    }
  }

  const filePath = dataPath('job_reviews.json');
  const reviews = readJSON(filePath, []);
  const filtered = reviews.filter(review => String(review.job_id) !== String(jobId));
  const persistedDecision = decision === 'restore' || decision === 'pending'
    ? 'pending'
    : decision === 'reconsider' ? 'approved' : decision;
  const record = {
    job_id: String(jobId),
    decision: persistedDecision,
    decided_at: new Date().toISOString(),
    decided_by: 'user_dashboard',
    reason: typeof body.reason === 'string' ? body.reason : '',
    notes: typeof body.notes === 'string' ? body.notes : ''
  };
  filtered.push(record);
  const targetStatus = ['approved', 'reconsider'].includes(decision)
    ? 'APPROVED_FOR_PACKAGE'
    : (decision === 'rejected' ? 'REJECTED' : (decision === 'manual_review' ? 'SAVED' : 'REVIEW_PENDING'));
  let transitioned;
  try {
    let transitionState = getDashboardState();
    const transitionRecord = transitionState.application_status_overrides[String(jobId)] || {};
    const transitionCurrentStatus = normalizeApplicationStatus(
      transitionRecord.application_status || transitionRecord.status || currentStatusForJob(jobId)
    );
    if (['restore', 'pending'].includes(decision)
      && transitionRecord.active_session_id
      && transitionCurrentStatus !== 'CANCELLED') {
      const error = new Error('This application has an active AI Fill attempt. Cancel it before returning the job to review.');
      error.code = 'ACTIVE_EXECUTION_CANCEL_REQUIRED';
      error.from_status = transitionCurrentStatus;
      error.to_status = 'REVIEW_PENDING';
      throw error;
    }
    if (decision === 'reconsider') {
      const restored = transitionApplicationState(transitionState, {
        jobId,
        toStatus: 'REVIEW_PENDING',
        actor: 'user_dashboard',
        reason: 'rejected_job_explicitly_restored_for_reconsideration',
        initialStatus: currentStatusForJob(jobId),
        recovery: true,
        idempotencyKey: `reconsider-restore:${jobId}:${body.idempotency_key || record.decided_at}`
      });
      transitionState = restored.state;
    }
    // A freshly imported job sits at DISCOVERED until a scoring run touches
    // it. The user approving it IS the review — hop through REVIEW_PENDING so
    // "paste a link → 用 AI 申请" works immediately, without waiting for a
    // batch scoring pass.
    if (['approved', 'rejected', 'manual_review'].includes(decision)
      && transitionCurrentStatus === 'DISCOVERED') {
      const reviewed = transitionApplicationState(transitionState, {
        jobId,
        toStatus: 'REVIEW_PENDING',
        actor: 'user_dashboard',
        reason: 'imported_job_entered_review_on_user_decision',
        initialStatus: 'DISCOVERED',
        idempotencyKey: `import-review:${jobId}:${body.idempotency_key || record.decided_at}`
      });
      transitionState = reviewed.state;
    }
    transitioned = transitionApplicationState(transitionState, {
      jobId,
      toStatus: targetStatus,
      actor: 'user_dashboard',
      reason: `review_decision_${decision}`,
      patch: ['restore', 'pending'].includes(decision) && transitionCurrentStatus === 'CANCELLED'
        ? {
            active_session_id: '', fill_approved_at: null, fill_approved_by: null,
            fill_started_at: null
          }
        : {},
      initialStatus: currentStatusForJob(jobId),
      recovery: decision === 'pending' || decision === 'restore',
      idempotencyKey: body.idempotency_key || ''
    });
  } catch (error) {
    let allowedActions = [];
    try {
      allowedActions = applicationAllowedTransitions(error.from_status || currentStatusForJob(jobId));
    } catch {
      // The original transition error remains authoritative; an unknown legacy
      // state simply has no safe automatic follow-up action.
      allowedActions = [];
    }
    return sendJSON(res, {
      status: 'blocked',
      code: error.code || 'INVALID_APPLICATION_TRANSITION',
      message: error.message,
      blockers: [error.message],
      from_status: error.from_status || '',
      to_status: error.to_status || targetStatus,
      current_state: error.from_status || currentStatusForJob(jobId),
      requested_action: requestedAction,
      allowed_actions: allowedActions,
      next_action: decision === 'approved'
        ? 'Restore the job to New or review its current application state before approving again.'
        : 'Review the current job lifecycle before changing this decision.',
      recommended_recovery_action: error.from_status === 'REJECTED'
        ? 'Use Restore to review or Reconsider and approve.'
        : 'Use one of the allowed actions shown for the current state.'
    }, 409);
  }
  let finalState = transitioned.state;
  const selectedBefore = Array.isArray(finalState.selected_job_ids)
    ? finalState.selected_job_ids.map(String)
    : [];
  let selectedAfter = selectedBefore.filter(selectedId => selectedId !== String(jobId));
  if (
    ['approved', 'reconsider'].includes(decision)
    && selectedBefore.includes(String(jobId))
  ) {
    selectedAfter = selectedBefore;
  } else if (
    ['approved', 'reconsider'].includes(decision)
    && selectedAfter.length < maximumJobsToOpen()
  ) {
    selectedAfter.push(String(jobId));
  }
  if (selectedAfter.join('\u001f') !== selectedBefore.join('\u001f')) {
    finalState.selected_job_ids = selectedAfter;
    finalState.updated_at = new Date().toISOString();
    finalState = appendAuditEvent(finalState, {
      eventType: 'SELECTION_CHANGED',
      actor: 'user_dashboard',
    reason: ['approved', 'reconsider'].includes(decision)
        ? 'approved_job_added_to_application_batch'
        : 'unapproved_job_removed_from_application_batch',
      metadata: {
        selected_job_ids: selectedAfter,
        selected_count: selectedAfter.length,
        maximum_jobs_to_open: maximumJobsToOpen()
      }
    }).state;
  }
  const backupPath = backupFile(filePath);
  const stateFilePath = dataPath('dashboard_state.json');
  const stateBackup = backupFile(stateFilePath);
  writeJSON(filePath, filtered);
  writeJSON(stateFilePath, finalState);

  // Saved is a durable flag on the job record, not a phase of the application
  // machine. Saving sets it; approving a previously-saved job KEEPS it (the
  // status moves on to the apply pipeline, the 收藏 mark must not vanish);
  // restoring to review clears it because the user explicitly reset the job.
  if (decision === 'manual_review') {
    setJobSavedFlag(jobId, true);
  } else if (transitioned.event?.from_status === 'SAVED' && ['approved', 'reconsider'].includes(decision)) {
    setJobSavedFlag(jobId, true);
  } else if (['restore', 'pending'].includes(decision)) {
    setJobSavedFlag(jobId, false);
  }

  const eventType = ['approved', 'reconsider'].includes(decision)
    ? 'JOB_APPROVED'
    : decision === 'rejected'
      ? 'JOB_REJECTED'
      : ['restore', 'pending'].includes(decision)
        ? 'JOB_RESTORED'
        : 'JOB_SAVED';
  publishDashboardEvent(eventType, {
    job_id: String(jobId),
    application_id: transitioned.record.application_id,
    status: transitioned.record.application_status,
    message: eventType === 'JOB_RESTORED' ? 'Job restored to review.' : 'Job state updated.'
  });
  sendJSON(res, {
    status: 'ok',
    record,
    backup: backupPath,
    state_backup: stateBackup,
    application_status: transitioned.record.application_status,
    audit_event: transitioned.event,
    selected_for_fill: selectedAfter.includes(String(jobId)),
    selected_job_ids: selectedAfter,
    transition: {
      from_status: transitioned.event?.from_status || transitioned.record.application_status,
      to_status: transitioned.record.application_status,
      decision,
      audit_event_id: transitioned.event?.event_id || '',
      persisted: true
    },
    archived_in_history: decision === 'rejected',
    next_action: ['approved', 'reconsider'].includes(decision)
      ? {
          label: 'Build Application Package',
          endpoint: `/api/jobs/${encodeURIComponent(String(jobId))}/build-package-preview`,
          application_status: transitioned.record.application_status
        }
      : decision === 'rejected'
        ? { label: 'View Rejected Jobs', application_status: transitioned.record.application_status }
        : { label: 'Review Job', application_status: transitioned.record.application_status },
    safety: {
      browser_opened: false,
      chrome_extension_called: false,
      apply_submit_clicked: false,
      resume_uploaded: false,
      application_submitted: false
    }
  });
}


function parseCommandJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    return { raw_stdout: text };
  }
}

function getJobPackageEligibility(job) {
  try {
    const decision = evaluateApplicationDecision(job);
    return {
      eligible: Boolean(
        job &&
        job.approval_status === 'approved' &&
        decision.allowed
      ),
      blockers: [...new Set([
        ...(job?.approval_status === 'approved' ? [] : ['Approve this job first.']),
        ...decision.blockers
      ])],
      warnings: decision.warnings,
      error: job?.approval_safety_error || null
    };
  } catch (error) {
    return {
      eligible: false,
      blockers: [`Approval safety is invalid: ${error.message}`],
      error: approvalSafetyErrorDetails(error)
    };
  }
}

async function handleBuildPackagePreview(req, res, jobId) {
  const job = getJobsWithOverlay().find((item) => String(item.job_id) === String(jobId));
  if (!job) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req); } catch (err) {
    return sendJSON(res, { status: 'error', code: 'INVALID_PACKAGE_REQUEST', message: err.message }, 400);
  }
  const resumeId = String(body.resume_id || '').trim();

  const eligibility = getJobPackageEligibility(job);
  if (!eligibility.eligible) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'PACKAGE_CONTRACT_BLOCKED',
      message: eligibility.blockers?.[0] || 'Package preview blocked. Approve a confirmed safe job detail page first.',
      blockers: eligibility.blockers || packageContractBlockers(job),
      job_id: String(jobId),
      approval_status: job.approval_status,
      page_type: job.page_type,
      approval_safety: job.approval_safety,
      approval_safety_error: eligibility.error,
      recommended_decision: job.recommended_decision,
      application_mode: job.application_mode,
      submit_allowed: job.submit_allowed === false ? false : null,
      upload_resume_allowed: job.upload_resume_allowed === false ? false : null,
      final_submit_allowed: job.final_submit_allowed === false ? false : null,
      safety: {
        browser_opened: false,
        chrome_extension_called: false,
        apply_submit_clicked: false,
        resume_uploaded: false,
        application_submitted: false
      }
    }, 409);
  }

  const currentStatus = currentStatusForJob(jobId);
  const currentRecord = getDashboardState().application_status_overrides[String(jobId)] || {};
  const packageStageNeedsInput = currentStatus === 'NEEDS_REVIEW'
    && !currentRecord.fill_started_at
    && !currentRecord.active_session_id
    && !currentRecord.latest_fill_report;
  const preExecutionRebuild = currentStatus === 'FILL_APPROVED'
    && !currentRecord.fill_started_at
    && !currentRecord.active_session_id;
  if (currentRecord.execution_recovery_required === true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'LEGACY_EXECUTION_RECOVERY_REQUIRED',
      message: 'This application has an older interrupted fill session. Recover the session before rebuilding the package.',
      application_status: currentStatus,
      recovery_action: {
        label: 'Recover and rebuild',
        endpoint: `/api/jobs/${encodeURIComponent(String(jobId))}/recover-execution`
      },
      safety: {
        package_files_modified: false,
        browser_opened: false,
        resume_uploaded: false,
        application_submitted: false
      }
    }, 409);
  }
  const rebuildAllowed = ['APPROVED_FOR_PACKAGE', 'PACKAGE_READY'].includes(currentStatus)
    || packageStageNeedsInput
    || preExecutionRebuild;
  if (!rebuildAllowed) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'PACKAGE_REBUILD_LOCKED',
      message: 'Resume version changes are locked after fill begins. Return to package review before rebuilding.',
      application_status: currentStatus,
      safety: {
        package_files_modified: false,
        browser_opened: false,
        resume_uploaded: false,
        application_submitted: false
      }
    }, 409);
  }

  const args = ['scripts/build_application_package_preview.mjs', '--job-id', String(jobId)];
  if (resumeId) args.push('--resume-id', resumeId);
  execFile('node', args, {
    cwd: PROJECT_ROOT,
    env: productProcessEnv(),
    timeout: 2 * 60 * 1000,
    maxBuffer: 1024 * 1024 * 5
  }, (error, stdout, stderr) => {
    if (error) {
      let parsed = {};
      let parseWarning = '';
      try { parsed = parseCommandJson(stderr || stdout); }
      catch { parseWarning = 'The package builder returned an unreadable error result.'; }
      const isProfileError = parsed.reason === 'profile_missing_or_invalid' || parsed.code === 'PROFILE_MISSING_OR_INVALID';
      return sendJSON(res, {
        status: 'blocked',
        message: isProfileError ? 'Profile required before package preview' : (parsed.message || error.message),
        code: parsed.code || 'PACKAGE_PREVIEW_BLOCKED',
        reason: parsed.reason || 'package_preview_blocked',
        details: parsed,
        output_parse_warning: parseWarning,
        blockers: isProfileError
          ? [
              'Approve the current Career Brain version or complete Profile approval.',
              ...((parsed.details?.failures || parsed.failures || []).map(item => String(item)))
            ]
          : (parsed.failures || [parsed.message || error.message]).map(item => String(item)),
        next_action: isProfileError
          ? 'Open Career Brain, review the detected facts, and approve the current Profile version.'
          : 'Review the package blocker details before retrying.',
        stderr_tail: tailText(stderr || ''),
        stdout_tail: tailText(stdout || ''),
        safety: {
          browser_opened: false,
          chrome_extension_called: false,
          apply_submit_clicked: false,
          resume_uploaded: false,
          application_submitted: false
        }
      }, 409);
    }

    let result = {};
    try { result = parseCommandJson(stdout); }
    catch {
      return sendJSON(res, {
        status: 'error', code: 'PACKAGE_RESULT_UNREADABLE',
        message: 'The Application Package builder returned an unreadable result. Try again; if it continues, check Advanced diagnostics.'
      }, 500);
    }

    const packageValue = readApplicationPackageForJob(jobId);
    const targetStatus = packageValue?.application_package?.status === 'PACKAGE_READY' ? 'PACKAGE_READY' : 'APPROVED_FOR_PACKAGE';
    let transitioned;
    try {
      transitioned = persistApplicationTransition(jobId, targetStatus, {
        actor: 'user_dashboard_build_package_preview',
        reason: targetStatus === 'PACKAGE_READY' ? 'package_ready' : 'package_requires_user_input',
        initialStatus: 'APPROVED_FOR_PACKAGE',
        recovery: (packageStageNeedsInput || preExecutionRebuild) && targetStatus === 'PACKAGE_READY',
        patch: {
          package_status: 'preview_created',
          package_id: result.package_id,
          package_path: result.package_path,
          package_files: result.files || [],
          application_id: result.application_id || packageValue?.application_package?.application_id || '',
          application_completion: packageValue?.application_package?.application_completion || null,
          ...(preExecutionRebuild ? { fill_approved_at: null, fill_approved_by: null } : {})
        }
      });
    } catch (transitionError) {
      return sendJSON(res, {
        status: 'error',
        code: transitionError.code || 'INVALID_APPLICATION_TRANSITION',
        message: transitionError.message
      }, 409);
    }

    publishDashboardEvent(currentStatus === 'PACKAGE_READY' ? 'PACKAGE_REBUILT' : 'PACKAGE_CREATED', {
      job_id: String(jobId),
      application_id: transitioned.record.application_id,
      status: transitioned.record.application_status,
      message: 'Application Package is ready for review.'
    });
    sendJSON(res, {
      status: 'ok',
      job_id: String(jobId),
      package_status: 'preview_created',
      application_status: transitioned.record.application_status,
      package_path: result.package_path,
      package_id: result.package_id,
      files: result.files || [],
      summary: result.summary || {},
      transition: {
        from_status: transitioned.event?.from_status || currentStatus,
        to_status: transitioned.record.application_status,
        audit_event_id: transitioned.event?.event_id || '',
        persisted: true
      },
      next_action: {
        label: 'Review Application Package',
        application_status: transitioned.record.application_status
      },
      resume_selection: result.resume_selection || null,
      backup: transitioned.backup,
      audit_event: transitioned.event,
      safety: {
        browser_opened: false,
        chrome_extension_called: false,
        apply_submit_clicked: false,
        resume_uploaded: false,
        application_submitted: false
      }
    });
  });
}

function recoveryBackupTargets(jobId) {
  const targets = [
    dataPath('dashboard_state.json'),
    dataPath('jobs_shortlist.json'),
    dataPath('job_reviews.json'),
    dataPath('career_profiles.local.json'),
    dataPath('resume_profiles.json')
  ];
  const packageDir = packageDirectoryForJob(jobId);
  if (packageDir && fs.existsSync(packageDir)) {
    for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
      if (entry.isFile()) targets.push(path.join(packageDir, entry.name));
    }
  }
  return [...new Set(targets.map(target => path.resolve(target)))];
}

async function handleRecoverApplicationExecution(req, res, jobId) {
  const job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId));
  if (!job) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_RECOVERY_REQUEST', message: error.message }, 400); }
  if (body.confirmed !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'RECOVERY_CONFIRMATION_REQUIRED',
      message: 'confirmed=true is required after reviewing the recovery explanation.'
    }, 409);
  }
  const recoveryIdempotencyKey = String(body.idempotency_key || '').trim();
  if (!recoveryIdempotencyKey) {
    return sendJSON(res, {
      status: 'error', code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'idempotency_key is required.'
    }, 400);
  }
  const rawExecutor = String(body.executor_type || body.executor_mode || '').trim();
  if (rawExecutor && !['extension', 'local_browser_agent', 'browser_agent'].includes(rawExecutor)) {
    return sendJSON(res, {
      status: 'error', code: 'INVALID_EXECUTOR_MODE', message: 'Executor must be Chrome Extension or Local Browser Agent.'
    }, 400);
  }

  const stateBefore = getDashboardState();
  const replaySession = Object.values(stateBefore.application_execution_sessions || {})
    .find(session => session.recovery_idempotency_key === recoveryIdempotencyKey);
  if (replaySession) {
    const replayRecord = stateBefore.application_status_overrides[String(jobId)] || {};
    return sendJSON(res, {
      status: 'ok',
      idempotent_replay: true,
      application_status: replayRecord.application_status || replayRecord.status || '',
      application_execution_session: replaySession,
      superseded_legacy_run_ids: replaySession.superseded_legacy_run_ids || [],
      backup: [],
      safety: {
        browser_opened: false, resume_uploaded: false, application_submitted: false
      }
    });
  }
  const currentRecord = stateBefore.application_status_overrides[String(jobId)] || {};
  if (currentRecord.execution_recovery_required !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'EXECUTION_RECOVERY_NOT_REQUIRED',
      message: 'This application does not have an interrupted legacy execution to recover.'
    }, 409);
  }
  const eligibility = getJobPackageEligibility(job);
  if (!eligibility.eligible) {
    return sendJSON(res, {
      status: 'blocked', code: 'PACKAGE_CONTRACT_BLOCKED',
      message: eligibility.blockers?.[0] || 'The approved job is no longer eligible for a package.',
      blockers: eligibility.blockers || []
    }, 409);
  }

  const profileSelection = approvedCareerProfileForRecovery();
  if (!profileSelection.approved_profile) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'APPROVED_PROFILE_MISSING',
      message: 'Recovery needs an explicitly approved Career Profile version in the active profile family.',
      active_profile_id: profileSelection.active_profile?.id || '',
      active_profile_state: profileSelection.active_profile?.state || 'missing',
      next_action: 'Review and approve a Career Profile version, then choose Recover and rebuild again.'
    }, 409);
  }
  const resumeStore = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles())).value;
  const activeResume = resumeStore.items.find(item => item.resume_id === resumeStore.active_resume_profile_id) || null;
  if (!activeResume || !activeResume.approved_at || activeResume.enabled === false || activeResume.archived_at) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'APPROVED_RESUME_MISSING',
      message: 'Recovery needs a current active, approved Resume Version.',
      next_action: 'Set an approved Resume Version active, then choose Recover and rebuild again.'
    }, 409);
  }

  const executor = normalizeExecutorMode(rawExecutor || currentRecord.selected_executor_type || currentRecord.executor);
  const backup = recoveryBackupTargets(jobId).map(target => ({
    source: path.relative(PROJECT_ROOT, target),
    backup: backupFile(target)
  }));
  let packageResult;
  try {
    packageResult = buildApplicationPackagePreview(jobId, {
      resumeId: activeResume.resume_id,
      careerProfileId: profileSelection.approved_profile.id
    });
  } catch (error) {
    return sendJSON(res, {
      status: 'blocked',
      code: error.code || 'RECOVERY_PACKAGE_REBUILD_FAILED',
      message: error.message,
      details: error.details || {},
      backup,
      safety: { browser_opened: false, resume_uploaded: false, application_submitted: false }
    }, 409);
  }
  const packageValue = readApplicationPackageForJob(jobId);
  if (!packageValue) {
    return sendJSON(res, {
      status: 'error', code: 'RECOVERY_PACKAGE_MISSING',
      message: 'The rebuilt Application Package could not be read.', backup
    }, 500);
  }

  let recovered;
  try {
    const session = createApplicationExecutionSession({
      applicationPackage: packageValue.application_package,
      manifest: packageValue.manifest,
      job,
      executorType: executor,
      targetUrl: resolveApplicationPageUrl(job),
      idempotencyKey: `recovery-session:${recoveryIdempotencyKey}`
    });
    recovered = recoverLegacyApplicationExecutionState(stateBefore, {
      jobId,
      actor: 'user_dashboard_execution_recovery',
      recoveryIdempotencyKey,
      session,
      packagePath: packageResult.package_path,
      packageFiles: packageResult.files || [],
      applicationCompletion: packageValue.application_package.application_completion || null
    });
  } catch (error) {
    return sendJSON(res, {
      status: 'blocked', code: error.code || 'EXECUTION_RECOVERY_FAILED',
      message: error.message, backup,
      safety: { browser_opened: false, resume_uploaded: false, application_submitted: false }
    }, 409);
  }
  writeJSON(dataPath('dashboard_state.json'), recovered.state);
  publishDashboardEvent('SESSION_CREATED', {
    job_id: String(jobId), application_id: recovered.session.application_id,
    session_id: recovered.session.session_id, status: recovered.record.application_status,
    message: 'The interrupted fill was recovered into a new draft attempt.'
  });
  return sendJSON(res, {
    status: 'ok',
    idempotent_replay: recovered.idempotent_replay,
    application_status: recovered.record.application_status,
    package_id: recovered.session.package_id,
    package_path: recovered.record.package_path,
    approved_profile_version: recovered.session.approved_profile_version,
    resume_version: packageValue.application_package.selected_resume || null,
    application_execution_session: recovered.session,
    superseded_legacy_run_ids: recovered.superseded_legacy_run_ids,
    backup,
    next_action: 'Review the rebuilt package and approve safe field fill.',
    safety: {
      browser_opened: false,
      resume_uploaded: false,
      application_submitted: false,
      historical_execution_preserved: true
    }
  });
}

function safeJobSegment(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'unknown_job';
}

function packageDirectoryForJob(jobId) {
  const state = getDashboardState();
  const override = state.application_status_overrides[String(jobId)] || {};
  const candidates = [
    path.join(APPLICATIONS_DIR, safeJobSegment(jobId)),
    override.package_path ? path.resolve(PROJECT_ROOT, override.package_path) : ''
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const insideConfiguredApplications = resolved === APPLICATIONS_DIR || resolved.startsWith(`${APPLICATIONS_DIR}${path.sep}`);
    const insideProjectApplications = resolved === path.join(PROJECT_ROOT, 'applications') || resolved.startsWith(`${path.join(PROJECT_ROOT, 'applications')}${path.sep}`);
    if ((insideConfiguredApplications || insideProjectApplications) && fs.existsSync(path.join(resolved, 'application_package.json'))) return resolved;
  }
  return '';
}

function readApplicationPackageForJob(jobId) {
  const packageDir = packageDirectoryForJob(jobId);
  if (!packageDir) return null;
  const applicationPackage = readJSON(path.join(packageDir, 'application_package.json'), null);
  if (!applicationPackage || String(applicationPackage.job_id) !== String(jobId)) return null;
  const manifest = readJSON(path.join(packageDir, 'package_manifest.json'), {});
  return {
    package_dir: path.relative(PROJECT_ROOT, packageDir),
    application_package: applicationPackage,
    manifest
  };
}

function currentApprovedProfileVersion() {
  const store = readCareerBrainStore();
  const profile = store.profiles.find(item => item.id === store.active_profile_id) || null;
  if (!profile || profile.user_approved !== true || profile.state !== 'approved' || !profile.approved_at) return null;
  return {
    profile_id: String(profile.id || ''),
    family_id: String(profile.family_id || ''),
    version: Number(profile.version || 0),
    approved_at: String(profile.approved_at || '')
  };
}

function sameApprovedProfileVersion(left, right) {
  return Boolean(
    left?.profile_id
    && right?.profile_id
    && String(left.profile_id) === String(right.profile_id)
    && Number(left.version || 0) === Number(right.version || 0)
    && String(left.approved_at || '') === String(right.approved_at || '')
  );
}

function approvedCareerProfileForRecovery() {
  const store = readCareerBrainStore();
  const active = store.profiles.find(item => item.id === store.active_profile_id) || null;
  const activeFamilyId = String(active?.family_id || active?.id || '');
  const eligible = store.profiles
    .filter(profile => profile?.user_approved === true && profile?.state === 'approved' && profile?.approved_at)
    .filter(profile => activeFamilyId && String(profile.family_id || profile.id || '') === activeFamilyId)
    .sort((left, right) => Number(right.version || 0) - Number(left.version || 0)
      || String(right.approved_at || '').localeCompare(String(left.approved_at || '')));
  return {
    store,
    active_profile: active,
    approved_profile: eligible[0] || null
  };
}

function executionBlocker(code, missing, message) {
  return { code, missing, message };
}

function applicationExecutionReadiness(jobId, {
  state = getDashboardState(),
  job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId)),
  packageValue = readApplicationPackageForJob(jobId),
  includeFillApproval = true,
  includeSelection = true
} = {}) {
  const record = state.application_status_overrides[String(jobId)] || {};
  const rawSession = record.active_session_id
    ? state.application_execution_sessions[record.active_session_id]
    : null;
  let session = null;
  let sessionError = null;
  if (rawSession) {
    try { session = assertApplicationExecutionSession(rawSession); }
    catch (error) { sessionError = error; }
  }

  if (sessionError) {
    return {
      allowed: false,
      session: null,
      blockers: [executionBlocker(
        sessionError.code || 'INVALID_APPLICATION_EXECUTION_SESSION',
        sessionError.code === 'APPROVED_PROFILE_VERSION_MISSING' ? 'Approved profile' : 'Fill setup',
        sessionError.message
      )]
    };
  }

  if (session) {
    if (String(session.job_id) !== String(jobId)) {
      return {
        allowed: false,
        session,
        blockers: [executionBlocker('SESSION_JOB_MISMATCH', 'Job', 'The active fill attempt belongs to a different job.')]
      };
    }
    const sessionBlockers = [];
    if (!job || job.approval_status !== 'approved' || !job.safe_to_approve) {
      sessionBlockers.push(executionBlocker(
        'APPROVED_JOB_MISSING',
        'Approved job',
        'Approve a safety-eligible job before starting AI Fill Assistant.'
      ));
    }
    if (!packageValue) {
      sessionBlockers.push(executionBlocker(
        'APPLICATION_PACKAGE_MISSING',
        'Application Package',
        'The saved fill attempt no longer has its reviewed package. Recover and rebuild before continuing.'
      ));
    } else {
      const currentPackageId = String(packageValue.application_package.package_id || packageValue.manifest.package_id || '');
      if (currentPackageId !== String(session.package_id)) {
        sessionBlockers.push(executionBlocker(
          'APPLICATION_SESSION_PACKAGE_MISMATCH',
          'Application Package',
          'The saved fill attempt belongs to a different package. Recover and rebuild before continuing.'
        ));
      }
      try {
        const packageProfile = approvedProfileVersionFromPackage(packageValue.application_package);
        if (!sameApprovedProfileVersion(packageProfile, session.approved_profile_version)) {
          sessionBlockers.push(executionBlocker(
            'APPLICATION_SESSION_PROFILE_MISMATCH',
            'Approved profile',
            'The fill attempt and package use different approved Career Profile versions.'
          ));
        }
      } catch (error) {
        sessionBlockers.push(executionBlocker(
          error.code || 'APPROVED_PROFILE_VERSION_MISSING',
          'Approved profile in Application Package',
          error.message
        ));
      }
    }
    if (includeSelection && !new Set((state.selected_job_ids || []).map(String)).has(String(jobId))) {
      sessionBlockers.push(executionBlocker(
        'SELECTED_JOB_MISSING',
        'Selected job',
        'Keep this approved job in the selected set before starting fill.'
      ));
    }
    if (!session.target_url) {
      sessionBlockers.push(executionBlocker(
        'APPLICATION_URL_MISSING',
        'Application URL',
        'Add or correct the public application URL before starting fill.'
      ));
    }
    if (session.execution_status === 'SESSION_CREATED') {
      if (includeFillApproval && !record.fill_approved_at) {
        sessionBlockers.push(executionBlocker(
          'FILL_APPROVAL_MISSING',
          'AI Fill approval',
          'Review the rebuilt package and approve safe field fill.'
        ));
      }
      return {
        allowed: sessionBlockers.length === 0,
        session,
        blockers: sessionBlockers
      };
    }
    const recoverable = session.execution_status === 'NEEDS_REVIEW'
      && Boolean(record.fill_approved_at)
      && currentStatusForJob(jobId) === 'NEEDS_REVIEW';
    const active = ['EXECUTOR_READY', 'EXTENSION_CONNECTED', 'FIELDS_DETECTED', 'FILLING']
      .includes(session.execution_status);
    const agentStatus = session.browser_agent?.status_path ? readJSON(session.browser_agent.status_path, {}) : {};
    const liveness = sessionLivenessSnapshot(session, { agentStatus });
    return {
      allowed: recoverable && sessionBlockers.length === 0,
      session,
      recovery_available: liveness.recovery_available,
      blockers: sessionBlockers.length ? sessionBlockers : recoverable ? [] : [executionBlocker(
        active
          ? (liveness.session_stale ? 'APPLICATION_SESSION_STALE' : 'APPLICATION_SESSION_ACTIVE')
          : 'APPLICATION_SESSION_NOT_RESTARTABLE',
        'Fill attempt',
        active
          ? (liveness.session_stale
            ? 'The previous fill attempt lost its browser connection. Use Restart Fill Setup to recover it.'
            : 'An AI Fill attempt is already active. Continue it from Review Package.')
          : 'The previous fill attempt is not ready to start again. Review its result before continuing.'
      )]
    };
  }

  if (record.execution_recovery_required === true) {
    return {
      allowed: false,
      session: null,
      blockers: [executionBlocker(
        'LEGACY_EXECUTION_RECOVERY_REQUIRED',
        'Recovered fill attempt',
        'This application has an older interrupted fill attempt. Choose Recover and rebuild to preserve its history and create a current attempt.'
      )]
    };
  }

  const blockers = [];
  const approvedProfile = currentApprovedProfileVersion();
  if (!approvedProfile) {
    blockers.push(executionBlocker(
      'APPROVED_PROFILE_MISSING',
      'Approved profile',
      'Approve the active Career Profile before building or starting an application.'
    ));
  }
  if (!job || job.approval_status !== 'approved' || !job.safe_to_approve) {
    blockers.push(executionBlocker(
      'APPROVED_JOB_MISSING',
      'Approved job',
      'Approve a safety-eligible job before starting AI Fill Assistant.'
    ));
  }
  if (!packageValue) {
    blockers.push(executionBlocker(
      'APPLICATION_PACKAGE_MISSING',
      'Application Package',
      'Build and review an Application Package before starting AI Fill Assistant.'
    ));
  } else {
    if (packageValue.application_package.status !== 'PACKAGE_READY') {
      blockers.push(executionBlocker(
        'APPLICATION_PACKAGE_NOT_READY',
        'Ready Application Package',
        'The Application Package still needs an approved resume version or user input.'
      ));
    }
    try {
      const packageProfile = approvedProfileVersionFromPackage(packageValue.application_package);
      if (approvedProfile && !sameApprovedProfileVersion(packageProfile, approvedProfile)) {
        blockers.push(executionBlocker(
          'APPLICATION_PACKAGE_PROFILE_STALE',
          'Current approved profile version',
          'This package was built from a different Career Profile version. Rebuild the package.'
        ));
      }
    } catch (error) {
      blockers.push(executionBlocker(
        error.code || 'APPROVED_PROFILE_VERSION_MISSING',
        'Approved profile in Application Package',
        error.message
      ));
    }
  }
  if (includeFillApproval && !record.fill_approved_at) {
    blockers.push(executionBlocker(
      'FILL_APPROVAL_MISSING',
      'AI Fill approval',
      'Review the package and approve safe field fill.'
    ));
  }
  if (includeSelection && !new Set((state.selected_job_ids || []).map(String)).has(String(jobId))) {
    blockers.push(executionBlocker(
      'SELECTED_JOB_MISSING',
      'Selected job',
      'Keep this approved job in the selected set before starting fill.'
    ));
  }
  if (job && !resolveApplicationPageUrl(job)) {
    blockers.push(executionBlocker(
      'APPLICATION_URL_MISSING',
      'Application URL',
      'Add or correct the public application URL before starting fill.'
    ));
  }
  return { allowed: blockers.length === 0, session: null, blockers };
}

function handleApplicationPackage(res, jobId) {
  const job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId));
  if (!job) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  const value = readApplicationPackageForJob(jobId);
  if (!value) return sendJSON(res, { status: 'missing', message: 'Application package not found', job_id: String(jobId) }, 404);
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  const startReadiness = applicationExecutionReadiness(jobId, { state, job, packageValue: value });
  const approvalReadiness = applicationExecutionReadiness(jobId, {
    state, job, packageValue: value, includeFillApproval: false
  });
  let packageProfileVersion = null;
  try { packageProfileVersion = approvedProfileVersionFromPackage(value.application_package); }
  catch { packageProfileVersion = null; }
  const resumes = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles()));
  const transientResumeSelection = selectBestResumeProfile(resumes.value, job);
  const packageResumeId = value.application_package.selected_resume?.resume_id || '';
  const localMockEligible = isLocalMockAtsUrl(job.url);
  sendJSON(res, {
    status: 'ok',
    job_id: String(jobId),
    package_path: value.package_dir,
    application_id: value.application_package.application_id || '',
    application_status: currentStatusForJob(jobId),
    active_session_id: record.active_session_id || '',
    application_execution_session: startReadiness.session,
    approved_profile_version: startReadiness.session?.approved_profile_version || packageProfileVersion,
    execution_readiness: {
      can_approve_fill: approvalReadiness.allowed,
      can_start_fill: startReadiness.allowed,
      approve_fill_blockers: approvalReadiness.blockers,
      start_fill_blockers: startReadiness.blockers
    },
    execution_recovery: {
      required: record.execution_recovery_required === true,
      reason: record.execution_recovery_reason || '',
      legacy_run_id: record.active_legacy_run_id || '',
      action: record.execution_recovery_required === true ? 'recover_and_rebuild' : ''
    },
    package_binding: {
      package_id: value.application_package.package_id || value.manifest.package_id || '',
      approved_profile: packageProfileVersion,
      resume_version: value.application_package.selected_resume || null
    },
    selected_executor_type: normalizeExecutorMode(
      startReadiness.session?.executor_type || record.selected_executor_type || record.executor
    ),
    fill_started_at: record.fill_started_at || null,
    latest_fill_report: record.latest_fill_report || null,
    package_status: value.application_package.status || value.manifest.package_status || 'unknown',
    package_version: value.application_package.package_version || '1.0',
    job_information: value.application_package.job_information || null,
    career_profile_reference: value.application_package.career_profile_reference || null,
    recommended_resume: value.application_package.recommended_resume || null,
    selected_resume: value.application_package.selected_resume || null,
    resume_recommendation: {
      ...transientResumeSelection.selection,
      selected_package_resume_id: packageResumeId,
      package_uses_recommendation: Boolean(
        packageResumeId
        && packageResumeId === transientResumeSelection.selection.recommended_resume_id
      )
    },
    cover_letter_draft: value.application_package.cover_letter_draft || null,
    cover_letter: value.application_package.cover_letter || null,
    // application_answers is the canonical serialization; planned_answers is a
    // read-compatibility echo for packages written before the convergence.
    planned_answers: value.application_package.application_answers
      || value.application_package.planned_answers
      || [],
    application_answers: value.application_package.application_answers
      || value.application_package.planned_answers
      || [],
    answer_provenance: value.application_package.answer_provenance || [],
    unanswered_questions: value.application_package.unanswered_questions || [],
    sensitive_questions: value.application_package.sensitive_questions || [],
    resume_intelligence: value.application_package.resume_intelligence || null,
    application_completion: value.application_package.application_completion || null,
    approval_safety: value.application_package.approval_safety || null,
    interview_preparation: value.application_package.interview_preparation || null,
    star_stories: value.application_package.star_stories || value.application_package.interview_preparation?.star_stories || [],
    missing_skills: value.application_package.missing_skills || value.application_package.interview_preparation?.missing_skills || [],
    risk: value.application_package.risk || null,
    timestamps: value.application_package.timestamps || {},
    mock_fill: {
      eligible: localMockEligible,
      localhost_only: true,
      profile: localMockEligible
        ? buildLocalMockFillProfile({
            job,
            applicationProfile: value.application_package.application_profile
          })
        : null
    },
    safety: {
      ...(value.application_package.safety || {}),
      local_read_only: true,
      final_submit_manual_only: true,
      resume_content_included: false
    }
  });
}

function currentStatusForJob(jobId) {
  const job = findJob(jobId) || {};
  const { overlay } = getLatestReviews();
  const state = getDashboardState();
  return deriveApplicationStatus({
    job,
    review: overlay[String(jobId)] || null,
    override: state.application_status_overrides[String(jobId)] || null
  });
}

function comparableJobPageUrl(value) {
  return canonicalizeJobUrl(value);
}

function resolveApplicationPageUrl(job = {}) {
  const candidates = [job.application_url, job.apply_url, job.url]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (url.hostname.toLowerCase() === 'jobs.lever.co' && !/\/apply(?:\/|$)/i.test(url.pathname)) {
        url.pathname = `${url.pathname.replace(/\/$/, '')}/apply`;
      }
      // Ashby splits the description and the form: the application form lives
      // at <job>/application. Opening the bare job URL scans zero fields.
      if (url.hostname.toLowerCase() === 'jobs.ashbyhq.com'
        && /^\/[^/]+\/[0-9a-f-]{36}$/i.test(url.pathname.replace(/\/$/, ''))) {
        url.pathname = `${url.pathname.replace(/\/$/, '')}/application`;
      }
      return url.toString();
    } catch {
      // Continue to the next persisted URL; existing start-fill gates surface failure.
    }
  }
  return '';
}

function extensionIdFromOrigin(req) {
  const match = String(req.headers.origin || '').match(/^chrome-extension:\/\/([a-z]{32})$/i);
  if (match) return match[1].toLowerCase();
  // Found by the installed-mode acceptance: an MV3 service-worker fetch to a
  // host-permitted URL bypasses CORS and omits the Origin header entirely, so
  // the real installed extension was refused here. The extension therefore
  // identifies itself with a custom header. A web page cannot deliver that
  // header to this server: a cross-origin request carrying it needs a CORS
  // preflight, and this server never grants one — and any page fetch DOES
  // carry an Origin header, which the check above already vets.
  if (req.headers.origin) return '';
  const headerId = String(req.headers['x-resume-jobs-extension-id'] || '').trim().toLowerCase();
  return /^[a-z]{32}$/.test(headerId) ? headerId : '';
}

function resolveExtensionHandoff(currentUrl) {
  const comparableCurrent = comparableJobPageUrl(currentUrl);
  if (!comparableCurrent) {
    return { status: 'error', code: 'INVALID_CURRENT_URL', message: 'A valid current page URL is required.' };
  }
  const state = getDashboardState();
  const jobs = getJobsWithOverlay();
  const candidates = jobs
    .map(job => {
      const record = state.application_status_overrides[String(job.job_id)] || {};
      const storedSession = record.active_session_id
        ? state.application_execution_sessions[record.active_session_id]
        : null;
      let session = null;
      try { if (storedSession) session = assertApplicationExecutionSession(storedSession); }
      catch { session = null; }
      return { job, record, session };
    })
    .filter(item => item.record.active_session_id && item.record.fill_started_at)
    .filter(item => {
      const status = item.session?.execution_status;
      if (normalizeExecutorMode(item.session?.executor_type) === EXECUTOR_MODES.EXTENSION) {
        return ['SESSION_CREATED', 'EXECUTOR_READY', 'EXTENSION_CONNECTED', 'FIELDS_DETECTED', 'FILLING', 'NEEDS_REVIEW'].includes(status);
      }
      // Local Browser Agent sessions: the extension still binds to the tab as
      // an OBSERVER, so its popup can show the matched job and live status on
      // the real application page. Filling stays owned by the agent — the
      // response's fill_owner tells the extension not to fill.
      return ['EXECUTOR_READY', 'EXTENSION_CONNECTED', 'FIELDS_DETECTED', 'FILLING', 'NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT'].includes(status);
    })
    .filter(item => {
      const target = item.session?.target_url || '';
      if (comparableJobPageUrl(target) === comparableCurrent) return true;
      // Extension-owned sessions bind by STRICT URL equality only — binding
      // transitions the session state machine and precedes active filling,
      // so a variant URL (a different gh_jid on the same page) must not
      // match. Agent-owned sessions bind the extension as a read-only
      // OBSERVER, so wizard steps and the agent's landed redirect URL (a
      // greenhouse link landing on the company's own careers domain) match
      // by application scope instead.
      if (normalizeExecutorMode(item.session?.executor_type) === EXECUTOR_MODES.EXTENSION) return false;
      if (withinApplicationScope(currentUrl, target)) return true;
      const agentStatus = readJSON(path.join(BROWSER_SESSIONS_DIR, String(item.session?.session_id || ''), 'status.json'), null);
      for (const candidateUrl of [agentStatus?.url, agentStatus?.current_url]) {
        if (candidateUrl && withinApplicationScope(currentUrl, candidateUrl)) return true;
      }
      return false;
    })
    .sort((left, right) => String(right.record.fill_started_at).localeCompare(String(left.record.fill_started_at)));
  const selected = candidates[0];
  if (!selected) {
    return {
      status: 'missing', code: 'ACTIVE_HANDOFF_NOT_FOUND',
      message: 'No active Dashboard fill handoff matches this page.', comparable_current_url: comparableCurrent
    };
  }
  return { status: 'ok', comparable_current_url: comparableCurrent, state, selected };
}

function handleExtensionActiveHandoff(req, res, currentUrl) {
  if (!extensionIdFromOrigin(req)) {
    return sendJSON(res, {
      status: 'blocked', code: 'EXTENSION_ORIGIN_REQUIRED',
      message: 'This private localhost handoff is available only to the Resume Jobs browser extension.'
    }, 403);
  }
  const resolved = resolveExtensionHandoff(currentUrl);
  if (resolved.status !== 'ok') {
    return sendJSON(res, {
      status: resolved.status, code: resolved.code, message: resolved.message
    }, resolved.code === 'INVALID_CURRENT_URL' ? 400 : 404);
  }
  const { state, selected } = resolved;
  /* Removed execution path: the extension consumes selected.session directly.
  const bridgePackage = {
    safe_job_id: String(selected.job.job_id),
    label: `${selected.job.company || 'Unknown company'} — ${selected.job.title || 'Untitled job'}`,
    job: {
      title: selected.job.title || '', company: selected.job.company || '', location: selected.job.location || '',
      job_url: resolveApplicationPageUrl(selected.job), provider_guess: selected.job.provider || '',
      score: Number(selected.job.match_score || 0)
    },
    application_profile: { base_profile: applicationProfile, job_specific_profile: {} },
    form_answers: formAnswers,
    status: {
      application_mode: 'REVIEW_ONLY', ready_for_autofill_preview: true,
      ready_for_final_application: false, needs_user_review: true,
      submit_allowed: false, upload_resume_allowed: false, final_submit_allowed: false
    }
  };
  */
  const connectedAt = new Date().toISOString();
  const fillOwner = normalizeExecutorMode(selected.session.executor_type);
  if (fillOwner === EXECUTOR_MODES.EXTENSION) {
    const connectedStatus = selected.session.execution_status === 'NEEDS_REVIEW'
      ? 'NEEDS_REVIEW'
      : 'EXTENSION_CONNECTED';
    selected.session = transitionApplicationExecutionSession({
      ...selected.session,
      connection: {
        status: 'CONNECTED',
        connected_at: connectedAt,
        url: currentUrl,
        executor: EXECUTOR_MODES.EXTENSION,
      }
    }, connectedStatus, { now: connectedAt });
    state.application_execution_sessions[selected.session.session_id] = selected.session;
    state.application_status_overrides[String(selected.job.job_id)] = selected.record;
    writeJSON(dataPath('dashboard_state.json'), state);
  }
  // Observer mode (fill owner = Local Browser Agent): the extension is bound
  // to the tab for status display only — the agent's session state machine is
  // never touched by this GET.
  const extensionId = extensionIdFromOrigin(req);
  const existingConnection = extensionConnections.get(extensionId) || {};
  extensionConnections.set(extensionId, {
    ...existingConnection,
    extension_id: extensionId,
    last_seen: connectedAt,
    current_tab: resolved.comparable_current_url,
    application_session_active: true,
    active_handoff: true,
    matched_application_id: String(selected.session.application_id),
    matched_job_id: String(selected.session.job_id),
    matched_package_id: String(selected.session.package_id),
    matched_session_id: String(selected.session.session_id)
  });
  return sendJSON(res, {
    status: 'ok', handoff_version: '2.0', dashboard_origin: `http://${HOST}:${PORT}`,
    session_id: selected.session.session_id,
    application_id: selected.session.application_id,
    job_id: selected.session.job_id,
    package_id: selected.session.package_id,
    executor_type: selected.session.executor_type,
    // Who is allowed to fill this session. 'extension' → the extension fills;
    // 'local_browser_agent' → the extension observes/reports only.
    fill_owner: fillOwner,
    target_url: selected.session.target_url,
    session_status: selected.session.execution_status,
    approved_field_mappings: selected.session.approved_field_mappings,
    display: selected.session.display,
    execution_session: {
      ...selected.session,
      confirmed_form_field_memory: readFormFieldMemory()
    },
    safety: {
      local_read_only: true, active_fill_run_required: true, current_url_matched: true,
      resume_file_content_included: false, final_submit_allowed: false
    }
  });
}

let cachedBundledExtensionVersion = '';
function bundledExtensionVersion() {
  if (cachedBundledExtensionVersion) return cachedBundledExtensionVersion;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'extensions', 'application_assistant', 'manifest.json'), 'utf8'));
    cachedBundledExtensionVersion = String(manifest.version || '');
  } catch {
    cachedBundledExtensionVersion = '';
  }
  return cachedBundledExtensionVersion;
}

function extensionDiagnosticsSnapshot(record = null) {
  const lastSeenMs = Date.parse(record?.last_seen || '');
  const fresh = Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs <= EXTENSION_CONNECTION_TTL_MS;
  return {
    status: 'ok',
    extension_installed: Boolean(record),
    extension_connected: Boolean(record && fresh),
    content_script_connected: Boolean(record && fresh && record.content_script_connected),
    application_session_active: Boolean(record?.application_session_active),
    active_handoff: Boolean(record?.active_handoff),
    // Origin + path only: the query string of an application URL can carry
    // personal data (?email=…) and this endpoint is readable by any local
    // process, like every other GET on this loopback server.
    current_tab: (() => {
      try {
        const url = new URL(String(record?.current_tab || ''));
        return `${url.origin}${url.pathname}`;
      } catch { return ''; }
    })(),
    matched_application_id: record?.matched_application_id || '',
    matched_job_id: record?.matched_job_id || '',
    matched_package_id: record?.matched_package_id || '',
    matched_session_id: record?.matched_session_id || '',
    extension_id: record?.extension_id || '',
    extension_version: record?.extension_version || '',
    // The version shipped in this product tree. A connected extension on any
    // OTHER version is stale (cached scripts or an old unpacked copy) and the
    // UI asks the user to reload it.
    expected_extension_version: bundledExtensionVersion(),
    extension_version_stale: Boolean(record?.extension_version
      && record.extension_version !== bundledExtensionVersion()),
    last_seen: record?.last_seen || null,
    freshness_seconds: Number.isFinite(lastSeenMs) ? Math.max(0, Math.floor((Date.now() - lastSeenMs) / 1000)) : null,
    connection_ttl_seconds: Math.floor(EXTENSION_CONNECTION_TTL_MS / 1000),
    connection_chain_ready: Boolean(record && fresh && record.content_script_connected && record.active_handoff),
    transport: 'localhost_http',
    native_messaging: {
      required: false,
      permission_declared: false,
      reason: 'The Manifest V3 extension uses authenticated extension-origin HTTP requests to the loopback Dashboard API.'
    },
    guidance: record && fresh
      ? (record.content_script_connected
          ? (record.active_handoff ? 'AI Fill Assistant is ready for this application.' : 'Start AI Fill Assistant from the approved Application Package.')
          : 'Reload the application page once after installing or updating the extension.')
      : 'Open the Resume Jobs extension once on the application page to complete setup.',
    safety: {
      candidate_values_included: false,
      resume_bytes_included: false,
      submit_permission_included: false
    }
  };
}

// The hostnames of every ACTIVE fill session (approved target + the agent's
// landed URL after redirects) — and nothing else. The extension polls this
// WITHOUT any page information, and sends a page's URL only when its host is
// listed: the privacy gate that makes the broad content-script injection
// carry zero browsing data for ordinary sites.
function handleExtensionActiveHosts(req, res) {
  if (!extensionIdFromOrigin(req)) {
    return sendJSON(res, {
      status: 'blocked', code: 'EXTENSION_ORIGIN_REQUIRED',
      message: 'This private localhost endpoint is available only to the Resume Jobs browser extension.'
    }, 403);
  }
  const state = getDashboardState();
  const activeStatuses = new Set([
    'SESSION_CREATED', 'EXECUTOR_READY', 'EXTENSION_CONNECTED',
    'FIELDS_DETECTED', 'FILLING', 'NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT'
  ]);
  const hosts = new Set();
  const addHost = (value) => {
    try { hosts.add(new URL(String(value)).hostname.toLowerCase()); } catch { /* not a URL */ }
  };
  for (const record of Object.values(state.application_status_overrides || {})) {
    if (!record?.active_session_id || !record?.fill_started_at) continue;
    const session = state.application_execution_sessions?.[record.active_session_id];
    if (!session || !activeStatuses.has(session.execution_status)) continue;
    addHost(session.target_url);
    const agentStatus = readJSON(path.join(BROWSER_SESSIONS_DIR, String(session.session_id || ''), 'status.json'), null);
    addHost(agentStatus?.url);
    addHost(agentStatus?.current_url);
  }
  return sendJSON(res, { status: 'ok', hosts: [...hosts] });
}

// One click on the page-side Assistant chip = "fill THIS step now". Reuses
// the retry command channel of the ALREADY-RUNNING Local Browser Agent — the
// agent re-classifies the page and fills only confirmed answers. Nothing new
// is authorized here, and a dead agent is never cold-started from a page.
function handleFillCurrentStep(req, res, jobId) {
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  const storedSession = record.active_session_id
    ? state.application_execution_sessions[record.active_session_id]
    : null;
  let session = null;
  try { if (storedSession) session = assertApplicationExecutionSession(storedSession); } catch { session = null; }
  if (!session || normalizeExecutorMode(session.executor_type) === EXECUTOR_MODES.EXTENSION) {
    return sendJSON(res, {
      status: 'blocked', code: 'NO_ACTIVE_AGENT_SESSION',
      message: 'No Local Browser Agent fill session is active for this job.'
    }, 409);
  }
  const activeStatuses = ['EXECUTOR_READY', 'EXTENSION_CONNECTED', 'FIELDS_DETECTED', 'FILLING', 'NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT'];
  if (!activeStatuses.includes(session.execution_status)) {
    return sendJSON(res, {
      status: 'blocked', code: 'SESSION_NOT_ACTIVE',
      message: 'The fill session is not active. Start the fill from Resume Jobs.'
    }, 409);
  }
  const existingProcess = browserAgentProcesses.get(session.session_id);
  const persistedProcessId = Number(session.browser_agent?.process_id || 0);
  const persistedProcessAlive = persistedProcessId > 0 && (() => {
    try { process.kill(persistedProcessId, 0); return true; } catch { return false; }
  })();
  if (!(existingProcess && existingProcess.exitCode === null) && !persistedProcessAlive) {
    return sendJSON(res, {
      status: 'blocked', code: 'AGENT_NOT_RUNNING',
      message: 'The assistant browser window is closed. Continue the application from Resume Jobs to reopen it.'
    }, 409);
  }
  const browserAgent = launchBrowserAgentSession({ session, action: 'retry_safe_fill' });
  return sendJSON(res, {
    status: 'ok',
    requested: true,
    agent_status: browserAgent.status || '',
    attempt_id: browserAgent.attempt_id || ''
  });
}

function handleGetExtensionDiagnostics(res) {
  const latest = [...extensionConnections.values()]
    .sort((left, right) => String(right.last_seen || '').localeCompare(String(left.last_seen || '')))[0] || null;
  return sendJSON(res, extensionDiagnosticsSnapshot(latest));
}

async function handlePostExtensionDiagnostics(req, res) {
  const extensionId = extensionIdFromOrigin(req);
  if (!extensionId) {
    return sendJSON(res, {
      status: 'blocked', code: 'EXTENSION_ORIGIN_REQUIRED',
      message: 'Extension diagnostics accept heartbeats only from a Chrome extension origin.'
    }, 403);
  }
  let body = {};
  try {
    body = await readRequestBody(req);
  } catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_EXTENSION_DIAGNOSTIC', message: error.message }, 400);
  }
  const currentTab = comparableJobPageUrl(body.current_url || '');
  if (!currentTab) {
    return sendJSON(res, {
      status: 'error', code: 'INVALID_CURRENT_URL',
      message: 'A valid HTTP(S) current tab URL is required.'
    }, 400);
  }
  const resolved = resolveExtensionHandoff(currentTab);
  const selected = resolved.status === 'ok' ? resolved.selected : null;
  const activeHandoff = Boolean(selected?.session?.connection?.status === 'CONNECTED');
  const record = {
    extension_id: extensionId,
    extension_version: String(body.extension_version || '').trim().slice(0, 32),
    last_seen: new Date().toISOString(),
    current_tab: currentTab,
    content_script_connected: body.content_script_connected === true,
    application_session_active: Boolean(selected?.session),
    active_handoff: activeHandoff,
    matched_application_id: selected ? String(selected.session.application_id || '') : '',
    matched_job_id: selected ? String(selected.session.job_id || '') : '',
    matched_package_id: selected ? String(selected.session.package_id || '') : '',
    matched_session_id: selected ? String(selected.session.session_id || '') : ''
  };
  extensionConnections.set(extensionId, record);
  return sendJSON(res, extensionDiagnosticsSnapshot(record));
}

function detectBrowserAgentExecutable() {
  // One detection order for the whole product (see agent_browser.mjs): env
  // override → local Chrome for Testing (the only build that can carry the
  // bundled extension) → branded Chrome/Edge.
  for (const candidate of agentBrowserCandidates(PROJECT_ROOT)) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function executorCapabilities() {
  const browserExecutable = detectBrowserAgentExecutable();
  const latestExtension = latestExtensionLastSeenMs();
  const extensionFresh = Number.isFinite(latestExtension)
    && Date.now() - latestExtension <= EXTENSION_CONNECTION_TTL_MS;
  return {
    recommended: EXECUTOR_MODES.BROWSER_AGENT,
    executors: {
      [EXECUTOR_MODES.BROWSER_AGENT]: {
        available: Boolean(browserExecutable),
        experimental: false,
        supports_rescan: true,
        supports_learning: true,
        supports_review_complete: true,
        requirements: browserExecutable
          ? []
          : ['Install Google Chrome or Microsoft Edge, or set RESUME_JOBS_CHROME_EXECUTABLE.']
      },
      [EXECUTOR_MODES.EXTENSION]: {
        available: extensionFresh,
        experimental: true,
        supports_rescan: false,
        supports_learning: false,
        supports_review_complete: false,
        requirements: extensionFresh
          ? []
          : ['Install the Chrome extension and open a page with it connected to this dashboard.']
      }
    }
  };
}

function handleExecutorCapabilities(res) {
  sendJSON(res, { status: 'ok', ...executorCapabilities() });
}

function handleExecutorStatus(res, jobId) {
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  const job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId)) || null;
  const packageValue = readApplicationPackageForJob(jobId);
  const readiness = applicationExecutionReadiness(jobId, { state, job, packageValue });
  const session = readiness.session;
  if (!session) {
    let packageProfileVersion = null;
    try { if (packageValue) packageProfileVersion = approvedProfileVersionFromPackage(packageValue.application_package); }
    catch { packageProfileVersion = null; }
    return sendJSON(res, {
      status: 'SESSION_NOT_CREATED',
      execution_status: 'SESSION_NOT_CREATED',
      connected: false,
      executor: normalizeExecutorMode(record.selected_executor_type || record.executor),
      session_id: '',
      application_id: packageValue?.application_package?.application_id || record.application_id || '',
      job_id: String(jobId || ''),
      package_id: packageValue?.application_package?.package_id || packageValue?.manifest?.package_id || '',
      approved_profile_version: packageProfileVersion,
      fields: { detected: 0, filled: 0, skipped: 0, failed: 0 },
      reasons: [],
      can_start_fill: readiness.allowed,
      blockers: readiness.blockers,
      missing: readiness.blockers.map(item => item.missing)
    });
  }
  const executor = normalizeExecutorMode(session.executor_type);
  const storedStatus = executor === EXECUTOR_MODES.BROWSER_AGENT && session.browser_agent?.status_path
    ? readJSON(session.browser_agent.status_path, {})
    : {};
  const latestReport = session.reports?.[session.reports.length - 1]?.application_execution
    || record.latest_fill_report?.application_execution
    || {};
  const counts = storedStatus.counts || latestReport.counts || {};
  const latestFieldResults = Array.isArray(latestReport.field_results)
    ? latestReport.field_results
    : Array.isArray(latestReport.fields)
      ? latestReport.fields
      : [];
  const challengeScope = storedStatus.challenge_scope || latestReport.challenge_scope || 'none';
  const submissionBlocker = storedStatus.submission_blocker || latestReport.submission_blocker || '';
  const latestAttempt = Array.isArray(session.execution_attempts) && session.execution_attempts.length
    ? session.execution_attempts[session.execution_attempts.length - 1]
    : null;
  const reasons = Array.isArray(storedStatus.reasons)
    ? storedStatus.reasons
    : latestFieldResults.length
      ? latestFieldResults.filter(field => field.outcome !== 'filled').map(field => field.reason)
      : [];
  const liveness = sessionLivenessSnapshot(session, { agentStatus: storedStatus });
  const connected = liveness.connection_live;
  const blockers = [];
  if (session.execution_status === 'SESSION_CREATED') {
    blockers.push(...readiness.blockers);
  } else if (!connected) {
    blockers.push(executionBlocker(
      executor === EXECUTOR_MODES.EXTENSION ? 'EXTENSION_CONNECTION_MISSING' : 'BROWSER_AGENT_CONNECTION_MISSING',
      executor === EXECUTOR_MODES.EXTENSION ? 'Extension connection' : 'Browser Agent connection',
      executor === EXECUTOR_MODES.EXTENSION
        ? 'Open the session target page with the installed extension enabled.'
        : 'The Local Browser Agent has not connected to this fill attempt.'
    ));
  } else if (Number(counts.detected || 0) === 0) {
    blockers.push(executionBlocker(
      'FIELDS_NOT_DETECTED',
      'Detected fields',
      'The executor is connected but has not reported application fields yet.'
    ));
  }
  return sendJSON(res, {
    status: session.execution_status,
    execution_status: session.execution_status,
    runtime_status: storedStatus.status || '',
    connected,
    connection_live: liveness.connection_live,
    session_stale: liveness.session_stale,
    recovery_available: liveness.recovery_available,
    connection: {
      source: liveness.connection_source,
      last_seen_at: liveness.last_seen_at,
      ttl_seconds: Math.floor(EXTENSION_CONNECTION_TTL_MS / 1000),
      stale_after_seconds: Math.floor(SESSION_STALE_TTL_MS / 1000),
      reasons: liveness.reasons
    },
    executor,
    url: storedStatus.url || session.connection?.url || session.target_url || '',
    application_id: session.application_id || '',
    package_id: session.package_id || '',
    session_id: session.session_id,
    job_id: session.job_id,
    approved_profile_version: session.approved_profile_version,
    portal: storedStatus.portal || latestReport.portal || '',
    fields: {
      detected: Number(counts.detected || 0),
      filled: Number(counts.filled || 0),
      skipped: Number(counts.skipped || 0),
      failed: Number(counts.failed || 0),
    },
    reasons: [...new Set(reasons.filter(Boolean))].slice(0, 12),
    reason_groups: storedStatus.reason_groups || latestReport.reason_groups || {},
    challenge_scope: challengeScope,
    submission_blocker: submissionBlocker,
    challenge_evidence: (storedStatus.challenge_evidence || latestReport.challenge_evidence || []).slice(0, 20),
    attempt: latestAttempt,
    attempts: session.execution_attempts || [],
    latest_review_rescan: session.latest_review_rescan || record.latest_review_rescan || null,
    user_message: challengeScope === 'active'
      ? 'The application form is blocked by a verification page. Complete it manually, then retry safe filling.'
      : challengeScope === 'passive'
        ? 'Safe fields were filled. Complete the verification and review the remaining fields manually.'
        : session.execution_status === 'NEEDS_REVIEW'
          ? 'Safe field processing is complete. Review every remaining field manually before submitting.'
          : '',
    available_actions: session.execution_status === 'NEEDS_REVIEW'
      ? executor === EXECUTOR_MODES.EXTENSION
        ? ['open_application_page', 'review_skipped_fields', 'retry_safe_fill']
        : ['open_application_page', 'review_skipped_fields', 'retry_safe_fill', 'review_rescan', 'mark_review_complete']
      : session.execution_status === 'READY_FOR_MANUAL_SUBMIT'
        ? ['open_application_page', 'mark_submitted_manually']
        : [],
    capability_limitations: executor === EXECUTOR_MODES.EXTENSION
      ? [{
          code: 'EXTENSION_RESCAN_UNSUPPORTED',
          message: 'The experimental extension cannot re-scan the form for review completion. Restart fill setup with the Local Browser Agent to finish the review, or continue fully manually.'
        }]
      : [],
    can_start_fill: readiness.allowed,
    blockers,
    missing: blockers.map(item => item.missing),
    safety: latestReport.safety || storedStatus.safety || {
      upload_attempted: false, login_attempted: false, challenge_attempted: false,
      submit_attempted: false, final_submit: false,
    },
  });
}

// Runs an existing HTTP handler in-process with a synthesized request/response
// so Quick Apply stays a thin orchestration over the exact same domain logic —
// no second workflow engine, no duplicated gates.
function internalCall(handler, body, ...args) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const listeners = {};
    const req = {
      headers: { 'content-type': 'application/json' },
      on(event, callback) {
        listeners[event] = callback;
        if (event === 'end') {
          queueMicrotask(() => {
            try {
              if (payload.length) listeners.data?.(Buffer.from(payload));
              listeners.end?.();
            } catch (error) { reject(error); }
          });
        }
        return req;
      }
    };
    const res = {
      statusCode: 200,
      setHeader() {},
      end(text) {
        try { resolve({ status: res.statusCode, value: text ? JSON.parse(text) : null }); }
        catch { resolve({ status: res.statusCode, value: null }); }
      }
    };
    Promise.resolve(handler(req, res, ...args)).catch(reject);
  });
}

function quickApplyPreflightSnapshot(jobId) {
  const packageValue = readApplicationPackageForJob(jobId);
  const applicationPackage = packageValue?.application_package || null;
  const answers = Array.isArray(applicationPackage?.application_answers)
    ? applicationPackage.application_answers
    : Array.isArray(applicationPackage?.planned_answers) ? applicationPackage.planned_answers : [];
  const requiresReview = Array.isArray(applicationPackage?.form_answers?.requires_review)
    ? applicationPackage.form_answers.requires_review
    : [];
  const profileView = applicationProfileViewSnapshot();
  // Per-category sensitive policy: 'manual' questions are entirely the user's
  // on the page — the preflight does not even prompt for them.
  const sensitivePolicies = normalizeSearchPreferences(readJSON(dataPath('search_preferences.json'), defaultSearchPreferences()))
    .value.safety?.sensitive_policies || {};
  const executorCore = globalThis.ResumeJobsApplicationExecutorCore;
  const promptable = requiresReview.filter(item => {
    const category = executorCore?.sensitiveQuestionCategory?.(String(item.original_question || '')) || '';
    return !category || sensitivePolicies[category] !== 'manual';
  });
  const needsUser = [
    ...profileView.readiness.needs_user,
    ...promptable.map(item => ({
      id: `answer_${item.id}`,
      label: item.original_question
        ? `Confirm your answer for: ${item.original_question}`
        : 'Confirm a stored answer that needs per-use review',
      kind: item.risk_level === 'high' ? 'high_risk_answer' : 'sensitive_answer'
    }))
  ];
  const tailored = tailoredResumeFor(jobId);
  return {
    tailored_resume: tailored ? {
      available: true,
      file_name: tailored.file_name,
      has_pdf: Boolean(tailored.pdf_path),
      stale_profile: tailored.stale_profile,
      content_complete: tailored.content_complete,
      coverage_warnings: tailored.coverage_warnings
    } : { available: false },
    package_id: applicationPackage?.package_id || packageValue?.manifest?.package_id || '',
    package_status: applicationPackage?.status || packageValue?.manifest?.package_status || 'unknown',
    selected_resume: applicationPackage?.selected_resume || null,
    safe_answers_count: answers.length,
    needs_user: needsUser,
    profile_ready: profileView.readiness.ready_for_safe_fill,
    ready_for_start: profileView.readiness.ready_for_safe_fill
      && applicationPackage?.status === 'PACKAGE_READY'
  };
}

// Make a discovered/imported job ready for the review-only apply flow when it
// is a genuine single job-detail page (an ATS posting URL). Discovery records
// don't carry the safety scaffolding; here we CLASSIFY at apply time and, only
// for real job_detail pages, attach the review-only locks (never auto-submit,
// never auto-upload without confirmation). Aggregator/board/careers-home pages
// stay non-approvable so the UI routes the user to open the real page.
// Returns { ready:true } or { ready:false, page_type }.
function ensureJobApplicationReady(jobId, { userConfirmedJobDetail = false } = {}) {
  // The full record (merged from leads + shortlist). The apply/package flow
  // reads jobs_shortlist.json, so a discovery lead must be upserted there with
  // the review-only safety scaffolding before it can be applied to.
  const record = getAllJobRecords().find(item => String(item.job_id) === String(jobId));
  if (!record) return { ready: false, page_type: 'unknown' };
  const pageType = record.page_type && record.page_type !== 'unknown' ? record.page_type : classifyPageType(record);
  // Official ATS board APIs (company_careers_*) return one REAL posting per
  // item — that IS direct posting evidence, so those leads need no extra
  // page-fetch verification: the agent browser's first scan verifies the live
  // form anyway, and nothing is ever filled on a page without one. A user's
  // explicit confirmation carries the same weight for other leads.
  const trustedDiscovery = /^company_careers_/.test(String(record.source || ''))
    || /^company_careers_/.test(String(record.discovery?.source || ''));
  const shortlistPath = dataPath('jobs_shortlist.json');
  const shortlist = readJSON(shortlistPath, []);
  const list = Array.isArray(shortlist) ? shortlist : [];
  const existing = list.find(item => String(item.job_id) === String(jobId));
  const alreadyReady = existing && existing.application_mode === 'REVIEW_ONLY'
    && existing.submit_allowed === false && existing.upload_resume_allowed === false && existing.final_submit_allowed === false
    && existing.approval_safety && typeof existing.approval_safety === 'object';
  if (alreadyReady) return { ready: true, page_type: existing.page_type || 'job_detail' };
  if (pageType !== 'job_detail' && !trustedDiscovery && !userConfirmedJobDetail) {
    return { ready: false, page_type: pageType };
  }
  const scaffolded = {
    ...record,
    page_type: 'job_detail',
    application_mode: 'REVIEW_ONLY',
    submit_allowed: false,
    upload_resume_allowed: false,
    final_submit_allowed: false,
    direct_posting_evidence: true,
    job_board_or_directory_evidence: false,
    approval_safety: createApprovalSafety('safe_to_approve', true, []),
    safe_to_approve: true,
    recommended_decision: 'approve',
  };
  const next = existing
    ? list.map(item => (String(item.job_id) === String(jobId) ? { ...item, ...scaffolded } : item))
    : [...list, scaffolded];
  backupFile(shortlistPath);
  writeJSON(shortlistPath, next);
  return { ready: true, page_type: 'job_detail' };
}

async function handleQuickApply(req, res, jobId) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  const job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId));
  if (!job) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  // Classify + scaffold real job-detail pages so the review-only apply flow can
  // proceed; non-detail pages report back so the UI opens the real page.
  const readiness = ensureJobApplicationReady(jobId, {
    userConfirmedJobDetail: body.user_confirmed_job_detail === true
  });
  if (!readiness.ready) {
    return sendJSON(res, {
      status: 'blocked', code: 'JOB_NOT_APPLICATION_PAGE', page_type: readiness.page_type,
      message: 'This lead is not a single application page yet — open the real page to apply.',
      blockers: ['not_single_application_page'],
    }, 409);
  }
  const steps = [];
  // A previously cancelled (不投了) application must never dead-end the job
  // with a raw state-machine 409: clicking 用 AI 申请 again IS the
  // reconsideration. Recover to REVIEW_PENDING FIRST — before the stale-
  // session recovery below, which cannot restart out of a terminal state —
  // and detach the cancelled session so the rebuild starts clean.
  if (currentStatusForJob(jobId) === 'CANCELLED') {
    try {
      const recovered = transitionApplicationState(getDashboardState(), {
        jobId,
        toStatus: 'REVIEW_PENDING',
        actor: 'quick_apply_preflight_reconsider',
        reason: 'user_reapplied_after_cancel',
        initialStatus: 'CANCELLED',
        recovery: true,
        patch: { active_session_id: '' },
        idempotencyKey: `preflight-reconsider:${jobId}:${Date.now().toString(36)}`
      });
      backupFile(dataPath('dashboard_state.json'));
      writeJSON(dataPath('dashboard_state.json'), recovered.state);
      steps.push({ step: 'reconsider_cancelled_application', status: 200 });
    } catch (error) {
      return sendJSON(res, {
        status: 'blocked', code: error.code || 'RECONSIDER_FAILED',
        message: error.message, steps
      }, 409);
    }
  }
  // An existing fill session decides what the preflight may do. A session that
  // is genuinely running (or waiting on the user) is never silently replaced —
  // the UI offers "continue" or an explicit restart instead. A session that
  // never started or died (stale, browser closed before any attempt) is
  // discarded automatically so the package can be rebuilt from the newest
  // profile/resume — the user never sees a raw "package locked" 409 for it.
  const preflightState = getDashboardState();
  const preflightRecord = preflightState.application_status_overrides[String(jobId)] || {};
  if (preflightRecord.active_session_id) {
    const activeSession = preflightState.application_execution_sessions[preflightRecord.active_session_id] || null;
    const projected = publicApplicationStateFor({
      applicationStatus: normalizeApplicationStatus(preflightRecord.application_status || preflightRecord.status || 'PACKAGE_READY'),
      session: activeSession,
      liveness: activeSession ? sessionLivenessSnapshot(activeSession) : null,
      awaitingVerification: awaitingVerificationFor(preflightRecord, activeSession)
    });
    if (['preparing', 'filling', 'needs_you', 'awaiting_verification', 'ready_to_submit'].includes(projected.state)) {
      return sendJSON(res, {
        status: 'blocked',
        code: 'APPLICATION_ALREADY_ACTIVE',
        state: projected.state,
        message: 'This application has already started filling. Continue it, or restart it to change the resume.',
      }, 409);
    }
    // ready_to_open / preparing-but-dead: cancel the stale attempt and rebuild.
    try {
      const restarted = restartApplicationExecutionSetup(preflightState, {
        jobId,
        actor: 'quick_apply_preflight_auto_recovery',
        idempotencyKey: `preflight-auto-restart:${jobId}:${preflightRecord.active_session_id}`,
        executorType: activeSession?.executor_type || preflightRecord.selected_executor_type || ''
      });
      backupFile(dataPath('dashboard_state.json'));
      writeJSON(dataPath('dashboard_state.json'), restarted.state);
      steps.push({ step: 'discard_stale_session', status: 200, session_id: preflightRecord.active_session_id });
    } catch (error) {
      return sendJSON(res, {
        status: 'blocked', code: error.code || 'STALE_SESSION_RECOVERY_FAILED',
        message: error.message, steps
      }, 409);
    }
  }
  // The approve step must run whenever the APPLICATION STATE is still before
  // approval — the job-level approval flag alone is not enough: recovery paths
  // (cancel-reconsideration, restores) return the state to REVIEW_PENDING
  // while the flag survives, and skipping approval then dead-ends the build.
  if (job.approval_status !== 'approved'
    || ['DISCOVERED', 'REVIEW_PENDING', 'SAVED'].includes(currentStatusForJob(jobId))) {
    const approved = await internalCall(handleDecision, {}, jobId, 'approved');
    steps.push({ step: 'approve_job', status: approved.status, code: approved.value?.code || '' });
    if (approved.status >= 400) {
      return sendJSON(res, {
        status: 'blocked',
        code: approved.value?.code || 'JOB_APPROVAL_BLOCKED',
        message: approved.value?.message || 'The job cannot be approved safely.',
        blockers: approved.value?.blockers || [],
        steps
      }, approved.status);
    }
  }
  const built = await internalCall(handleBuildPackagePreview, { resume_id: body.resume_id || '' }, jobId);
  steps.push({ step: 'build_package', status: built.status, code: built.value?.code || '' });
  if (built.status >= 400) {
    return sendJSON(res, {
      status: 'blocked',
      code: built.value?.code || 'PACKAGE_BUILD_BLOCKED',
      message: built.value?.message || 'The application package could not be built.',
      blockers: built.value?.blockers || [],
      steps
    }, built.status);
  }
  const preflight = quickApplyPreflightSnapshot(jobId);
  sendJSON(res, {
    status: 'ok',
    job_id: String(jobId),
    application_status: built.value?.application_status || currentStatusForJob(jobId),
    steps,
    preflight,
    executor: executorCapabilities(),
    safety: { browser_opened: false, resume_uploaded: false, application_submitted: false }
  });
}

// The Assistant's "发现新问题" flow: the user answered newly discovered
// ordinary questions on a live page. Each answer is saved as user-confirmed
// knowledge (canonical key + variants + source site), attached to the RUNNING
// session's approved mappings, and the fill retries so the answers land on
// the page immediately. AI never invents an answer here — only what the user
// typed is stored or filled.
async function handleSaveOpenAnswers(req, res, jobId) {
  let body = {};
  try { body = await readRequestBody(req); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_OPEN_ANSWERS', message: error.message }, 400); }
  if (body.confirmed !== true) {
    return sendJSON(res, { status: 'blocked', code: 'CONFIRMATION_REQUIRED', message: 'confirmed=true is required.' }, 409);
  }
  const answers = (Array.isArray(body.answers) ? body.answers : [])
    .map(item => ({
      question: String(item?.question || '').trim().slice(0, 500),
      answer: String(item?.answer || '').trim().slice(0, 2000)
    }))
    .filter(item => item.question && item.answer)
    .slice(0, 10);
  if (!answers.length) {
    return sendJSON(res, { status: 'error', code: 'NO_ANSWERS', message: 'At least one answered question is required.' }, 400);
  }
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  const sessionId = String(record.active_session_id || '');
  const session = sessionId ? state.application_execution_sessions[sessionId] : null;
  if (!session) {
    return sendJSON(res, {
      status: 'blocked', code: 'APPLICATION_EXECUTION_SESSION_NOT_FOUND',
      message: 'No active fill attempt was found for this job.'
    }, 409);
  }
  const core = globalThis.ResumeJobsApplicationExecutorCore;
  let sourceSite = '';
  try { sourceSite = new URL(session.target_url).hostname.toLowerCase(); } catch { sourceSite = ''; }
  const savedKeys = [];
  const newMappings = [];
  for (const entry of answers) {
    const sensitive = Boolean(core?.isSensitiveQuestion?.(entry.question));
    let saved;
    try {
      saved = saveAnswerRecord({
        original_question: entry.question,
        answer: entry.answer,
        source: 'user_confirmed',
        user_confirmed: true,
        // A sensitive question that slipped through is stored as sensitive so
        // it can never silently auto-reuse; the fill layer refuses it anyway.
        sensitive_category: sensitive ? 'sensitive' : 'none',
        risk_level: sensitive ? 'high' : 'normal',
        source_site: sourceSite,
        question_variants: [entry.question]
      });
    } catch (error) {
      return sendJSON(res, { status: 'error', code: 'INVALID_ANSWER_MEMORY', message: error.message }, 400);
    }
    savedKeys.push(saved.record.canonical_key);
    if (!sensitive) {
      newMappings.push({
        canonical_key: saved.record.canonical_key,
        value: entry.answer,
        source: 'confirmed_answer_memory',
        confidence: 1,
        user_confirmed: true,
        question_id: saved.record.question_id,
        aliases: [...new Set([entry.question, ...(saved.record.question_variants || [])])].slice(0, 25)
      });
    }
  }
  if (newMappings.length) {
    const mappings = Array.isArray(session.approved_field_mappings) ? [...session.approved_field_mappings] : [];
    for (const mapping of newMappings) {
      const existingIndex = mappings.findIndex(item => item.canonical_key === mapping.canonical_key);
      if (existingIndex >= 0) mappings[existingIndex] = { ...mappings[existingIndex], ...mapping };
      else mappings.push(mapping);
    }
    state.application_execution_sessions[sessionId] = {
      ...session,
      approved_field_mappings: mappings,
      updated_at: new Date().toISOString()
    };
    backupFile(dataPath('dashboard_state.json'));
    writeJSON(dataPath('dashboard_state.json'), state);
  }
  // Retry the fill so the confirmed answers land on the page now; the new
  // attempt also invalidates the old scan, which triggers a fresh re-scan.
  const refill = await internalCall(handleStartFill, {
    confirmed: true,
    idempotency_key: `open-answers:${jobId}:${Date.now().toString(36)}`
  }, jobId);
  publishDashboardEvent('OPEN_ANSWERS_SAVED', {
    job_id: String(jobId), session_id: sessionId,
    message: `${savedKeys.length} answer(s) saved to the knowledge base.`
  });
  return sendJSON(res, {
    status: 'ok',
    saved: savedKeys,
    refill_status: refill.status,
    safety: { ai_generated_answers: false, application_submitted: false }
  });
}

// Guarantees jobId is in selected_job_ids before a fill starts. When the
// batch is full, slots whose jobs have no active fill session are released
// first (they can re-enter the same way); jobs mid-fill are never evicted.
function ensureJobSelectedForFill(jobId) {
  const state = getDashboardState();
  let selected = (state.selected_job_ids || []).map(String);
  if (selected.includes(String(jobId))) return;
  const maximum = maximumJobsToOpen();
  if (selected.length >= maximum) {
    const overrides = state.application_status_overrides || {};
    selected = selected.filter(id => Boolean(overrides[id]?.active_session_id));
  }
  while (selected.length >= maximum) selected.shift();
  selected.push(String(jobId));
  state.selected_job_ids = selected;
  state.updated_at = new Date().toISOString();
  const audited = appendAuditEvent(state, {
    jobId,
    eventType: 'SELECTION_CHANGED',
    actor: 'quick_apply_start',
    reason: 'job_auto_selected_on_fill_start',
    metadata: { selected_job_ids: selected, selected_count: selected.length, maximum_jobs_to_open: maximum }
  });
  backupFile(dataPath('dashboard_state.json'));
  writeJSON(dataPath('dashboard_state.json'), audited.state);
}

async function handleQuickApplyStart(req, res, jobId) {
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  if (body.confirmed !== true) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'QUICK_APPLY_CONFIRMATION_REQUIRED',
      message: 'confirmed=true is required after reviewing the preflight.'
    }, 409);
  }
  const job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId));
  if (!job) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  const steps = [];
  const confirmedAnswers = Array.isArray(body.confirmed_answers) ? body.confirmed_answers : [];
  const savedAnswers = [];
  const coreFactUpdates = {};
  // Answers that ARE core profile facts also flow back into the fallback
  // candidate profile, so a fact answered once (location, a name part, a
  // link) is PROFILE_KNOWN from then on and never asked again.
  const CORE_FACT_TARGETS = {
    full_name: ['full_name'],
    first_name: ['first_name'],
    last_name: ['last_name'],
    email: ['email'],
    phone: ['phone'],
    location: ['current_location', 'location', 'city'],
    linkedin_url: ['linkedin'],
    github_url: ['github'],
    portfolio_url: ['portfolio']
  };
  for (const answer of confirmedAnswers) {
    if (answer?.user_confirmed !== true) continue;
    try {
      const saved = saveAnswerRecord({ ...answer, source: answer.source || 'user_confirmed', user_confirmed: true });
      savedAnswers.push(saved.record.question_id);
      const targets = CORE_FACT_TARGETS[saved.record.canonical_key];
      const value = String(saved.record.answer || '').trim();
      if (targets && value) for (const key of targets) coreFactUpdates[key] = value;
    } catch (error) {
      return sendJSON(res, {
        status: 'error', code: 'INVALID_ANSWER_MEMORY',
        message: error.message, steps
      }, 400);
    }
  }
  if (Object.keys(coreFactUpdates).length) {
    const factPath = path.join(DATA_DIR, 'candidate_profile.local.json');
    const existingFacts = readJSON(factPath, {});
    backupFile(factPath);
    writePrivateJSON(factPath, { ...existingFacts, ...coreFactUpdates });
    steps.push({ step: 'persist_core_facts', status: 200, keys: Object.keys(coreFactUpdates) });
  }
  if (savedAnswers.length) {
    steps.push({ step: 'save_confirmed_answers', status: 200, saved: savedAnswers.length });
    const rebuilt = await internalCall(handleBuildPackagePreview, {}, jobId);
    steps.push({ step: 'rebuild_package', status: rebuilt.status, code: rebuilt.value?.code || '' });
    if (rebuilt.status >= 400) {
      return sendJSON(res, {
        status: 'blocked', code: rebuilt.value?.code || 'PACKAGE_BUILD_BLOCKED',
        message: rebuilt.value?.message || 'The application package could not be rebuilt.', steps
      }, rebuilt.status);
    }
  }
  // The fill gate requires the job in the application batch
  // (selected_job_ids). Approval adds it when there is room, but a job that
  // was approved long ago — or approved while the batch was full — can be
  // missing, which surfaced to users as an opaque "Cannot approve AI Fill".
  // Starting the application IS selecting it: ensure membership here, freeing
  // slots held by jobs that have no live fill session.
  ensureJobSelectedForFill(jobId);
  const executorType = normalizeExecutorMode(body.executor_type || '');
  const currentRecord = getDashboardState().application_status_overrides[String(jobId)] || {};
  const hasSession = Boolean(currentRecord.active_session_id);
  if (!hasSession) {
    const approvedFill = await internalCall(handleApproveFill, {
      confirmed: true,
      executor_type: executorType
    }, jobId);
    steps.push({ step: 'approve_fill', status: approvedFill.status, code: approvedFill.value?.code || '' });
    if (approvedFill.status >= 400) {
      return sendJSON(res, {
        status: 'blocked', code: approvedFill.value?.code || 'FILL_APPROVAL_BLOCKED',
        message: approvedFill.value?.message || 'AI Fill could not be approved.',
        blockers: approvedFill.value?.blockers || [], steps
      }, approvedFill.status);
    }
  }
  const started = await internalCall(handleStartFill, {
    confirmed: true,
    executor_type: executorType,
    resume_choice: body.resume_choice === 'tailored' ? 'tailored' : 'main',
    idempotency_key: String(body.idempotency_key || `quick-apply:${jobId}`)
  }, jobId);
  steps.push({ step: 'start_fill', status: started.status, code: started.value?.code || '' });
  if (started.status >= 400) {
    return sendJSON(res, {
      status: 'blocked', code: started.value?.code || 'START_FILL_BLOCKED',
      message: started.value?.message || 'Safe filling could not start.',
      blockers: started.value?.blockers || [], steps
    }, started.status);
  }
  sendJSON(res, {
    status: 'ok',
    job_id: String(jobId),
    steps,
    executor_type: executorType,
    application_execution_session: started.value?.application_execution_session || null,
    record: started.value?.record || null,
    safety: started.value?.safety || { browser_opened: false, resume_uploaded: false, application_submitted: false }
  });
}

const REVIEW_BLOCKER_CHECKLIST_ITEMS = {
  REQUIRED_FIELDS_INCOMPLETE: { id: 'required_fields', label: 'Fill the remaining required fields', kind: 'form_fields' },
  REQUIRED_FIELD_UNKNOWN: { id: 'unknown_required_fields', label: 'Decide the required fields that still need you', kind: 'user_decision' },
  FILE_UPLOAD_REQUIRED: { id: 'resume_attach', label: 'Attach your resume', kind: 'manual_file' },
  FORM_NOT_ACCESSIBLE: { id: 'form_access', label: 'Reopen the application form', kind: 'manual_navigation' },
  ACTIVE_CHALLENGE: { id: 'captcha', label: 'Complete verification', kind: 'manual_verification' },
  LOGIN_REQUIRED: { id: 'login', label: 'Sign in to the portal yourself', kind: 'manual_authentication' },
  UNSUPPORTED_FORM: { id: 'unsupported_form', label: 'Complete this form manually', kind: 'manual_form' }
};

// Extracted so /api/applications/:id/checklist and /api/jobs/:id/apply-state
// render the same list from the same computation. Two endpoints describing the
// same job must never be able to disagree.
function internalChecklistSnapshot(jobId, { state: sharedState = null } = {}) {
  const state = sharedState || getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  const applicationStatus = record.application_status
    ? normalizeApplicationStatus(record.application_status)
    : deriveApplicationStatus({ job: findJob(jobId) || {}, override: record });
  const sessionId = String(record.active_session_id || '');
  const session = sessionId ? state.application_execution_sessions[sessionId] : null;
  // Before any fill attempt exists there is nothing to review: the re-scan /
  // confirm items describe a filled form. Listing them for a job that only has
  // a package produced the permanent "还有 2 项" that could never be cleared.
  const preFill = ['DISCOVERED', 'REVIEW_PENDING', 'SAVED', 'APPROVED_FOR_PACKAGE', 'PACKAGE_READY', 'FILL_APPROVED']
    .includes(applicationStatus);
  if (preFill && (!session || session.execution_status === 'SESSION_CREATED')) {
    return {
      application_status: applicationStatus,
      scan_state: 'not_started',
      items: [],
      things_left: 0,
      can_mark_review_complete: false,
      // The user may have applied on the site entirely by hand before any fill
      // attempt; their declaration must stay possible from these states too —
      // this flag must never disagree with what /submitted-manually accepts.
      can_mark_submitted: USER_DECLARABLE_SUBMIT_STATUSES.has(applicationStatus)
    };
  }
  const scan = session?.latest_review_rescan || record.latest_review_rescan || null;
  const freshness = session
    ? reviewScanFreshness(scan, session)
    : { fresh: false, reason: scan ? 'no_active_session' : 'missing_scan' };
  const validScan = Boolean(scan) && freshness.fresh;
  const reviewConfirmed = ['READY_FOR_MANUAL_SUBMIT', 'MANUALLY_SUBMITTED'].includes(applicationStatus);
  const liveness = session ? sessionLivenessSnapshot(session) : null;
  const browserOpen = liveness?.connection_live === true;
  // "The page is closed — reopen it" only makes sense when the product OWNS
  // the window (Local Browser Agent). An extension session lives in the
  // user's own browser; a quiet heartbeat there is not a closed page.
  const ownsBrowserWindow = session
    && normalizeExecutorMode(session.executor_type) === EXECUTOR_MODES.BROWSER_AGENT;
  const items = [];
  if (!reviewConfirmed && ownsBrowserWindow && !browserOpen) {
    // The page the user has to act on is gone. Asking them to re-scan or fill
    // fields on a closed window is a dead end — the ONE item is reopening,
    // and it disappears by itself once the fill session reconnects.
    items.push({
      id: 'reopen_page',
      label: 'The application page is closed — reopen it to continue',
      kind: 'reopen_application',
      required: true,
      done: false
    });
  } else if (!validScan && !reviewConfirmed) {
    items.push({
      id: 'review_rescan',
      label: scan ? 'Re-scan the application form (the last scan is stale)' : 'Re-scan the application form',
      kind: 'review_rescan',
      required: true,
      done: false
    });
  }
  // The checklist derives from the exact blocker computation used by
  // "Mark review complete" — the two can never disagree. Field-count blockers
  // are expanded into the REAL fields from the live page scan, so the user
  // sees "手机号 / 验证码 / …", never an opaque "N required fields".
  // With the page closed the scan describes a window that no longer exists:
  // reopening is the only actionable item, so scan-derived items are skipped.
  const pageClosed = items.some(item => item.id === 'reopen_page');
  const blockers = validScan && !pageClosed
    ? computeReviewBlockers(scan, { resumeUploadConfirmed: sessionResumeUploadConfirmed(session) })
    : [];
  let fieldItemsExpanded = false;
  for (const blocker of blockers) {
    if (['REQUIRED_FIELDS_INCOMPLETE', 'REQUIRED_FIELD_UNKNOWN'].includes(blocker.code)) {
      if (fieldItemsExpanded) continue;
      // One checklist entry per QUESTION: radio/checkbox options that share a
      // group collapse into a single item (a group counts as answered when any
      // of its options is selected), and duplicate hidden/visible twins of the
      // same control collapse by group_key too.
      const missingGroups = new Map();
      const questionKeyOf = field => (['radio', 'checkbox'].includes(field.type)
        ? field.group_key
        : field.normalized_question || field.group_key) || field.field_ref;
      for (const field of Array.isArray(scan.fields) ? scan.fields : []) {
        if (field.required !== true) continue;
        // File uploads have their own dedicated item (resume_attach), which a
        // verified automatic upload clears — never a per-field entry.
        if (field.type === 'file') continue;
        const key = questionKeyOf(field);
        const existing = missingGroups.get(key);
        if (existing) {
          existing.filled = existing.filled || field.filled === true;
          if (field.group_label && !existing.group_label) existing.group_label = field.group_label;
          const memberLabel = (field.label || '').trim();
          if (memberLabel && !existing.member_labels.includes(memberLabel)) existing.member_labels.push(memberLabel);
          continue;
        }
        missingGroups.set(key, {
          key,
          group_label: (field.group_label || '').trim(),
          member_labels: [(field.label || '').trim()].filter(Boolean),
          filled: field.filled === true,
          sensitive: field.sensitive === true,
          mapped_key: field.mapped_key || '',
          reason: field.reason || field.classification || '',
          field_ref: field.field_ref
        });
      }
      // A group's display label: its legend when one exists; otherwise, for a
      // multi-option group, an honest "choose one of: …" line.
      for (const group of missingGroups.values()) {
        group.label = group.group_label
          || (group.member_labels.length > 1
            ? `Select an option: ${group.member_labels.slice(0, 4).join(' / ')}${group.member_labels.length > 4 ? ' …' : ''}`
            : group.member_labels[0] || '');
      }
      const missing = [...missingGroups.values()].filter(group => !group.filled);
      if (missing.length) {
        fieldItemsExpanded = true;
        for (const group of missing.slice(0, 10)) {
          const id = `field_${String(group.key || group.label || '').replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
          if (items.some(item => item.id === id)) continue;
          items.push({
            id,
            label: group.label || `Unlabeled required field (${group.field_ref})`,
            kind: 'form_field',
            required: true,
            done: false,
            // Sensitive questions (work authorization, EEO, salary…) are the
            // user's to answer every time — the UI marks them so the user
            // knows why they were never auto-filled.
            sensitive: group.sensitive,
            mapped_key: group.mapped_key,
            detail: group.reason
          });
        }
        if (missing.length > 10) {
          items.push({
            id: 'fields_more',
            label: `…and ${missing.length - 10} more required fields on the page`,
            kind: 'form_fields',
            required: true,
            done: false
          });
        }
        continue;
      }
    }
    const template = REVIEW_BLOCKER_CHECKLIST_ITEMS[blocker.code]
      || { id: blocker.code.toLowerCase(), label: blocker.message || blocker.code, kind: 'manual_review' };
    if (items.some(item => item.id === template.id)) continue;
    items.push({ ...template, required: true, done: false, detail: blocker.message || '' });
  }
  // The final confirmation is the user's own sign-off. It only appears once
  // every real blocker above is cleared (or none exist) — it must never be
  // the thing that keeps an application in "needs you" forever.
  if (reviewConfirmed || (validScan && !pageClosed && blockers.length === 0)) {
    items.push({
      id: 'review_confirm',
      label: 'Confirm you reviewed every field',
      kind: 'confirmation',
      required: true,
      done: reviewConfirmed
    });
  }
  const openItems = items.filter(item => item.required && !item.done);
  return {
    application_status: applicationStatus,
    scan_state: validScan ? 'fresh' : (scan ? `stale_${freshness.reason}` : 'missing'),
    browser_open: browserOpen,
    items,
    things_left: openItems.length,
    can_mark_review_complete: validScan && blockers.length === 0 && applicationStatus === 'NEEDS_REVIEW',
    can_mark_submitted: USER_DECLARABLE_SUBMIT_STATUSES.has(applicationStatus)
  };
}

function handleApplicationChecklist(res, jobId) {
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  if (!findJob(jobId) && !record.job_id) {
    return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  }
  return sendJSON(res, { status: 'ok', job_id: String(jobId), ...internalChecklistSnapshot(jobId) });
}


async function handleExecutorSelection(req, res, jobId) {
  if (!findJob(jobId)) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_EXECUTOR_SELECTION', message: error.message }, 400); }
  const rawExecutor = String(body.executor_type || body.executor_mode || '').trim();
  if (!['extension', 'local_browser_agent', 'browser_agent'].includes(rawExecutor)) {
    return sendJSON(res, {
      status: 'error', code: 'INVALID_EXECUTOR_MODE', message: 'Executor must be Chrome Extension or Local Browser Agent.'
    }, 400);
  }
  const executor = normalizeExecutorMode(rawExecutor);
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  let session = record.active_session_id ? state.application_execution_sessions[record.active_session_id] : null;
  if (session && session.execution_status !== 'SESSION_CREATED') {
    return sendJSON(res, {
      status: 'blocked',
      code: 'EXECUTOR_SELECTION_LOCKED',
      message: 'Executor selection is locked after filling starts. Restart or recover fill setup to change it.',
      application_session_id: session.session_id,
      execution_status: session.execution_status,
      recovery_action: 'Restart AI Fill Setup'
    }, 409);
  }
  if (session) {
    try {
      session = assertApplicationExecutionSession({
        ...session,
        executor_type: executor,
        updated_at: new Date().toISOString()
      });
      state.application_execution_sessions[session.session_id] = session;
    } catch (error) {
      return sendJSON(res, {
        status: 'blocked', code: error.code || 'INVALID_APPLICATION_EXECUTION_SESSION', message: error.message
      }, 409);
    }
  }
  state.application_status_overrides[String(jobId)] = {
    ...record,
    selected_executor_type: executor,
    executor,
    updated_at: new Date().toISOString(),
    updated_by: 'user_dashboard_executor_selection'
  };
  const audited = appendAuditEvent(state, {
    jobId,
    applicationId: session?.application_id || record.application_id || '',
    sessionId: session?.session_id || '',
    eventType: 'EXECUTOR_SELECTED',
    actor: 'user_dashboard_executor_selection',
    reason: 'executor_selection_changed',
    metadata: { executor_type: executor, execution_status: session?.execution_status || 'NOT_CREATED' }
  });
  const filePath = dataPath('dashboard_state.json');
  const backup = backupFile(filePath);
  writeJSON(filePath, audited.state);
  publishDashboardEvent('EXECUTOR_SELECTED', {
    job_id: String(jobId), application_id: session?.application_id || record.application_id || '',
    session_id: session?.session_id || '', status: session?.execution_status || 'NOT_CREATED',
    message: executor === EXECUTOR_MODES.BROWSER_AGENT ? 'Local Browser Agent selected.' : 'Chrome Extension selected.'
  });
  return sendJSON(res, {
    status: 'ok',
    executor_type: executor,
    application_execution_session: session,
    backup,
    safety: { browser_opened: false, application_submitted: false }
  });
}

async function stopOwnedBrowserAgentForRestart(session) {
  const child = browserAgentProcesses.get(session?.session_id);
  if (!child || child.exitCode !== null) return { stopped: false, reason: 'not_running' };
  const closed = new Promise(resolve => {
    child.once('close', () => resolve(true));
    setTimeout(() => resolve(false), 5000).unref?.();
  });
  child.kill('SIGTERM');
  const stopped = await closed;
  return { stopped, reason: stopped ? 'owned_process_stopped' : 'owned_process_stop_timeout' };
}

async function handleRestartFillSetup(req, res, jobId) {
  if (!findJob(jobId)) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_FILL_SETUP_RESTART', message: error.message }, 400); }
  if (body.confirmed !== true) {
    return sendJSON(res, {
      status: 'blocked', code: 'FILL_SETUP_RESTART_CONFIRMATION_REQUIRED',
      message: 'Confirm the restart after reviewing its explanation.'
    }, 409);
  }
  const idempotencyKey = String(body.idempotency_key || '').trim();
  if (!idempotencyKey) {
    return sendJSON(res, { status: 'error', code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'idempotency_key is required.' }, 400);
  }
  const rawExecutor = String(body.executor_type || body.executor_mode || '').trim();
  if (rawExecutor && !['extension', 'local_browser_agent', 'browser_agent'].includes(rawExecutor)) {
    return sendJSON(res, { status: 'error', code: 'INVALID_EXECUTOR_MODE', message: 'Choose Chrome Extension or Local Browser Agent.' }, 400);
  }
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  const session = record.active_session_id ? state.application_execution_sessions[record.active_session_id] : null;
  if (session?.browser_agent?.process_id && !browserAgentProcesses.has(session.session_id)) {
    try {
      process.kill(Number(session.browser_agent.process_id), 0);
      return sendJSON(res, {
        status: 'blocked', code: 'BROWSER_AGENT_OWNERSHIP_UNVERIFIED',
        message: 'The controlled browser may still be running from an earlier Dashboard process. Close that controlled browser window, then restart fill setup.'
      }, 409);
    } catch {
      // ESRCH means the previous process no longer exists; continuing recovery
      // is safe because this Dashboard does not own a live child for it.
    }
  }
  const processStop = await stopOwnedBrowserAgentForRestart(session);
  if (processStop.reason === 'owned_process_stop_timeout') {
    return sendJSON(res, {
      status: 'blocked', code: 'BROWSER_AGENT_STOP_TIMEOUT',
      message: 'The controlled browser is still closing. Wait a moment, then retry restart fill setup.'
    }, 409);
  }
  let restarted;
  try {
    restarted = restartApplicationExecutionSetup(state, {
      jobId,
      actor: 'user_dashboard_restart_fill_setup',
      idempotencyKey,
      executorType: rawExecutor || session?.executor_type || record.selected_executor_type,
      now: new Date().toISOString()
    });
  } catch (error) {
    return sendJSON(res, { status: 'blocked', code: error.code || 'FILL_SETUP_RESTART_FAILED', message: error.message }, 409);
  }
  const backup = backupFile(dataPath('dashboard_state.json'));
  writeJSON(dataPath('dashboard_state.json'), restarted.state);
  publishDashboardEvent('FILL_SETUP_RESTARTED', {
    job_id: String(jobId), application_id: restarted.record.application_id || '',
    session_id: restarted.cancelled_session?.session_id || '', status: restarted.record.application_status,
    message: 'Fill setup restarted. The previous session and reports were preserved.'
  });
  return sendJSON(res, {
    status: 'ok', application_status: restarted.record.application_status,
    selected_executor_type: restarted.record.selected_executor_type,
    previous_session_preserved: true,
    cancelled_session_id: restarted.cancelled_session?.session_id || '',
    idempotent_replay: restarted.idempotent_replay,
    backup,
    safety: { browser_opened: false, resume_uploaded: false, application_submitted: false }
  });
}

// Best-effort, product-profile-only environment cleanup before a cold agent
// launch. Never touches other Chrome installs or profiles: the orphan sweep
// matches the command line against THIS product's unique profile folder, and
// only cache directories are deleted (never cookies, logins, history).
function cleanupAgentBrowserEnvironment(profileDir) {
  if (process.platform === 'win32') {
    try {
      const listed = execFileSync('powershell', [
        '-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*browser_profiles*resume-jobs-agent*' } | Select-Object -ExpandProperty ProcessId"
      ], { timeout: 10_000, windowsHide: true }).toString();
      for (const line of listed.split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid); } catch { /* already gone */ }
        }
      }
    } catch {
      // Listing failed (no PowerShell, timeout): the launch may still succeed;
      // a locked profile surfaces as an honest BROWSER_AGENT_START_FAILED.
    }
  }
  for (const cacheDir of ['Extension Scripts', 'Extension Rules', 'Extension State', 'Service Worker']) {
    try { fs.rmSync(path.join(profileDir, 'Default', cacheDir), { recursive: true, force: true }); }
    catch { /* cache stays; the version handshake still flags stale extensions */ }
  }
  // Command-line (--load-extension) records whose source folder no longer
  // exists linger in the profile after a rename and would keep a dead
  // extension identity around; drop them, and pin the Assistant's stable id
  // (manifest "key") so its icon is visible on the toolbar, not hidden behind
  // the puzzle-piece menu. Preferences is only read at Chrome start, so the
  // cold-start cleanup is the one safe moment to edit it.
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'extensions', 'application_assistant', 'manifest.json'), 'utf8'));
    const assistantId = manifest.key
      ? [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
          .map(byte => 'abcdefghijklmnop'[(byte >> 4) & 0xf] + 'abcdefghijklmnop'[byte & 0xf]).join('')
      : '';
    for (const prefsName of ['Preferences', 'Secure Preferences']) {
      const prefsPath = path.join(profileDir, 'Default', prefsName);
      if (!fs.existsSync(prefsPath)) continue;
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      let changed = false;
      const settings = prefs?.extensions?.settings;
      if (settings && typeof settings === 'object') {
        for (const [extensionId, record] of Object.entries(settings)) {
          const commandLineInstall = Number(record?.location) === 8;
          const sourcePath = String(record?.path || '');
          if (commandLineInstall && sourcePath && !fs.existsSync(sourcePath)) {
            delete settings[extensionId];
            changed = true;
          }
        }
      }
      if (prefsName === 'Preferences' && assistantId) {
        prefs.extensions = prefs.extensions || {};
        const pinned = Array.isArray(prefs.extensions.pinned_extensions) ? prefs.extensions.pinned_extensions : [];
        const keep = pinned.filter(id => id === assistantId || fs.existsSync(String(settings?.[id]?.path || '')) || !settings?.[id]);
        if (!keep.includes(assistantId)) keep.push(assistantId);
        if (JSON.stringify(keep) !== JSON.stringify(pinned)) { prefs.extensions.pinned_extensions = keep; changed = true; }
      }
      if (changed) fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    }
  } catch {
    // Profile hygiene is best-effort: a malformed Preferences file must never
    // block the launch — Chrome rebuilds what it needs.
  }
}

function launchBrowserAgentSession({ session, action = 'retry_safe_fill', scanId = '' }) {
  const existingProcess = browserAgentProcesses.get(session.session_id);
  const persistedProcessId = Number(session.browser_agent?.process_id || 0);
  const persistedProcessAlive = persistedProcessId > 0 && (() => {
    try { process.kill(persistedProcessId, 0); return true; } catch { return false; }
  })();
  const sessionId = session.session_id.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const sessionDir = path.join(BROWSER_SESSIONS_DIR, sessionId);
  const retryCommandPath = path.join(sessionDir, 'retry-command.json');
  if ((existingProcess && existingProcess.exitCode === null) || persistedProcessAlive) {
    writePrivateJSON(retryCommandPath, {
      command: action,
      session_id: session.session_id,
      attempt_id: session.active_attempt_id,
      scan_id: scanId,
      requested_at: new Date().toISOString(),
      safety: {
        upload_resume: session.safety?.resume_upload_allowed === true,
        login: false, solve_challenge: false, final_submit: false
      }
    });
    return {
      ...(session.browser_agent || {}),
      session_id: sessionId,
      retry_command_path: retryCommandPath,
      attempt_id: session.active_attempt_id,
      process_id: existingProcess?.pid || persistedProcessId || null,
      status: action === 'review_rescan' ? 'REVIEW_RESCAN_REQUESTED' : 'RETRY_REQUESTED',
    };
  }
  if ([...browserAgentProcesses.entries()].some(([sessionKey, child]) => sessionKey !== session.session_id && child && child.exitCode === null)) {
    throw new Error('Another Local Browser Agent is active. Close its browser window before starting a new session.');
  }
  const profileDir = path.join(BROWSER_PROFILES_DIR, 'resume-jobs-agent');
  // Cold start owns the environment: recover orphaned Chromium processes that
  // still hold OUR profile (a crashed agent leaves them behind and the next
  // launch would fail on the profile lock), then purge the profile's cached
  // extension scripts so a stale unpacked-extension version can never run
  // against the current backend. Cookies/logins are untouched.
  cleanupAgentBrowserEnvironment(profileDir);
  const contextPath = path.join(sessionDir, 'context.json');
  const statusPath = path.join(sessionDir, 'status.json');
  const reportPath = path.join(sessionDir, 'ApplicationExecution.json');
  const screenshotsDir = path.join(sessionDir, 'screenshots');
  const logPath = path.join(sessionDir, 'browser-agent.log');
  const targetUrl = session.target_url;
  writePrivateJSON(contextPath, {
    ...session,
    authorized: true,
    final_submit: false,
    // Resume upload runs only when the session carries the matching per-job
    // authorization (safety.resume_upload_allowed + resume_upload_authorization,
    // both re-verified by the agent). Login, challenges and Submit stay off.
    upload_resume: session.safety?.resume_upload_allowed === true,
    login: false,
    solve_challenge: false,
    executor: session.executor_type,
    url: targetUrl,
    // The file staged for THIS job — the user's main resume by default, the
    // experimental tailored draft only on explicit choice. The agent re-checks
    // the job binding, the staleness flag and the file fingerprints before any
    // upload. Falls back to the tailored lookup only for older sessions that
    // predate staged_resume on the session.
    staged_resume: session.staged_resume || (() => {
      const tailored = tailoredResumeFor(session.job_id);
      return tailored ? {
        job_id: tailored.job_id,
        resume_source: 'tailored',
        draft_id: tailored.draft_id,
        file_name: tailored.file_name,
        docx_path: tailored.docx_path,
        pdf_path: tailored.pdf_path || '',
        sha256: tailored.docx_sha256,
        docx_sha256: tailored.docx_sha256,
        pdf_sha256: tailored.pdf_sha256 || '',
        stale_profile: tailored.stale_profile
      } : null;
    })(),
    field_memory: readFormFieldMemory(),
    callback_url: `http://${HOST}:${PORT}/api/jobs/${encodeURIComponent(session.job_id)}/fill-report`,
    review_rescan_callback_url: `http://${HOST}:${PORT}/api/jobs/${encodeURIComponent(session.job_id)}/review-rescan-report`,
    learning_callback_url: `http://${HOST}:${PORT}/api/jobs/${encodeURIComponent(session.job_id)}/learning-candidates/report`,
  });
  fs.mkdirSync(sessionDir, { recursive: true });
  const descriptor = fs.openSync(logPath, 'a');
  const browserAgentArgs = [
    path.join(PROJECT_ROOT, 'browser_agent', 'run.mjs'),
    '--context', contextPath,
    '--report', reportPath,
    '--status', statusPath,
    '--screenshots', screenshotsDir,
    '--profile-dir', profileDir,
    '--retry-command', retryCommandPath,
  ];
  const testModeAllowed = process.env.RESUME_JOBS_BROWSER_AGENT_TEST_MODE === '1'
    && (() => {
      try { return ['127.0.0.1', 'localhost'].includes(new URL(targetUrl).hostname); }
      catch { return false; }
    })();
  if (testModeAllowed) {
    browserAgentArgs.push('--headless-test');
    if (process.env.RESUME_JOBS_BROWSER_AGENT_KEEP_OPEN_TEST !== '1') browserAgentArgs.push('--close-after-fill');
  }
  if (action === 'review_rescan') browserAgentArgs.push('--initial-action', 'review_rescan', '--scan-id', scanId);
  const child = spawn(process.execPath, browserAgentArgs, {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    stdio: ['ignore', descriptor, descriptor],
  });
  browserAgentProcesses.set(session.session_id, child);
  child.once('error', error => {
    writeJSON(statusPath, {
      status: 'FAILED', executor: EXECUTOR_MODES.BROWSER_AGENT, session_id: session.session_id,
      job_id: String(session.job_id), url: targetUrl,
      reason: 'Local Browser Agent could not start. Check browser installation and retry.',
      technical_error_code: String(error?.code || 'BROWSER_AGENT_PROCESS_ERROR'),
      updated_at: new Date().toISOString(),
    });
  });
  child.once('close', () => {
    browserAgentProcesses.delete(session.session_id);
    try { fs.closeSync(descriptor); }
    catch {
      // The child has already closed. Descriptor cleanup is best-effort and
      // does not change the persisted execution result.
    }
  });
  return {
    session_id: sessionId,
    status_path: statusPath,
    report_path: reportPath,
    package_id: session.package_id,
    process_id: child.pid || null,
    retry_command_path: retryCommandPath,
    attempt_id: session.active_attempt_id,
    status: action === 'review_rescan' ? 'REVIEW_RESCAN_STARTING' : 'STARTING',
  };
}

function persistApplicationTransition(jobId, toStatus, {
  actor,
  reason,
  patch = {},
  initialStatus = currentStatusForJob(jobId),
  idempotencyKey = '',
  recovery = false,
  sessionId = ''
}) {
  const filePath = dataPath('dashboard_state.json');
  const backup = backupFile(filePath);
  const result = transitionApplicationState(getDashboardState(), {
    jobId,
    toStatus,
    actor,
    reason,
    patch,
    initialStatus,
    idempotencyKey,
    recovery,
    sessionId
  });
  writeJSON(filePath, result.state);
  return { ...result, backup };
}

async function handleApproveFill(req, res, jobId) {
  const job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId));
  if (!job) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  if (job.approval_status !== 'approved' || !job.safe_to_approve) {
    return sendJSON(res, { status: 'blocked', message: 'Fill approval requires an approved, safety-eligible job.' }, 409);
  }
  const packageValue = readApplicationPackageForJob(jobId);
  if (!packageValue) return sendJSON(res, { status: 'blocked', message: 'Build and review an application package before approving fill.' }, 409);
  const approvalReadiness = applicationExecutionReadiness(jobId, {
    job,
    packageValue,
    includeFillApproval: false
  });
  if (!approvalReadiness.allowed) {
    return sendJSON(res, {
      status: 'blocked',
      code: approvalReadiness.blockers[0]?.code || 'FILL_APPROVAL_BLOCKED',
      message: 'Cannot approve AI Fill.',
      missing: approvalReadiness.blockers.map(item => item.missing),
      blockers: approvalReadiness.blockers
    }, 409);
  }
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  if (body.confirmed !== true) return sendJSON(res, { status: 'blocked', message: 'confirmed=true is required after reviewing the package.' }, 409);
  const now = new Date().toISOString();
  try {
    const currentStatus = currentStatusForJob(jobId);
    const stateBefore = getDashboardState();
    const currentRecord = stateBefore.application_status_overrides[String(jobId)] || {};
    const requestedExecutor = normalizeExecutorMode(
      body.executor_type || body.executor_mode || currentRecord.selected_executor_type || currentRecord.executor
    );
    const idempotencyKey = String(body.idempotency_key || [
      'prepare',
      jobId,
      packageValue.application_package.package_id || packageValue.manifest.package_id || '',
      requestedExecutor
    ].join(':'));
    const session = createApplicationExecutionSession({
      applicationPackage: packageValue.application_package,
      manifest: packageValue.manifest,
      job,
      executorType: requestedExecutor,
      targetUrl: resolveApplicationPageUrl(job),
      idempotencyKey
    });
    const prepared = prepareApplicationExecutionSession(stateBefore, {
      jobId,
      actor: 'user_dashboard_approve_fill',
      idempotencyKey,
      session,
      initialStatus: currentStatus,
      now
    });
    prepared.record.fill_approved_at = prepared.record.fill_approved_at || now;
    prepared.record.fill_approved_by = 'user_dashboard';
    prepared.record.package_path = packageValue.package_dir;
    prepared.record.package_id = prepared.session.package_id;
    prepared.record.application_id = prepared.session.application_id;
    prepared.state.application_status_overrides[String(jobId)] = prepared.record;
    const filePath = dataPath('dashboard_state.json');
    const backup = backupFile(filePath);
    writeJSON(filePath, prepared.state);
    publishDashboardEvent('SESSION_CREATED', {
      job_id: String(jobId),
      application_id: prepared.session.application_id,
      session_id: prepared.session.session_id,
      status: prepared.record.application_status,
      message: 'AI Fill setup created from the reviewed package.'
    });
    sendJSON(res, {
      status: 'ok',
      record: prepared.record,
      application_execution_session: prepared.session,
      idempotent_replay: prepared.idempotent_replay,
      backup,
      audit_event: prepared.event
    });
  } catch (error) {
    sendJSON(res, {
      status: 'blocked',
      code: error.code || 'INVALID_APPLICATION_TRANSITION',
      message: error.message,
      current_state: currentStatusForJob(jobId),
      requested_action: 'approve_safe_fill',
      allowed_actions: applicationAllowedTransitions(currentStatusForJob(jobId)),
      recommended_recovery_action: 'Review the Application Package and resolve the displayed blocker before trying again.'
    }, 409);
  }
}

// Requirement: never stage a stale or missing tailored resume. Before an
// upload is authorized, the draft is (re)generated deterministically and
// re-exported whenever the active profile moved past the draft's version or
// the files are missing. AI is never invoked here — apply time must not spend
// tokens or wait on a model.
async function ensureFreshTailoredResume(jobId) {
  const actions = [];
  const existing = tailoredResumeFor(jobId);
  if (existing && !existing.stale_profile) return { ok: true, tailored: existing, actions };

  const draft = readResumeDraft(jobId);
  const store = readCareerBrainStore();
  const active = store.profiles.find(item => item.id === store.active_profile_id) || null;
  const staleDraft = Boolean(draft && active
    && (active.id !== draft.profile_id || Number(active.version) !== Number(draft.profile_version)));
  if (!draft || staleDraft) {
    const generated = await internalCall(handleGenerateResumeDraft, { use_ai: false }, jobId);
    if (generated.status >= 400) {
      return {
        ok: false, actions,
        code: generated.value?.code || 'RESUME_DRAFT_GENERATION_FAILED',
        message: generated.value?.message || 'The tailored resume draft could not be generated.'
      };
    }
    actions.push(draft ? 'regenerated_stale_draft' : 'generated_draft');
  }
  const exported = await internalCall(handleExportResumeDraft, {}, jobId);
  if (exported.status >= 400) {
    return {
      ok: false, actions,
      code: exported.value?.code || 'RESUME_EXPORT_FAILED',
      message: exported.value?.message || 'The tailored resume files could not be exported.'
    };
  }
  actions.push('exported_files');
  const tailored = tailoredResumeFor(jobId);
  if (!tailored || tailored.stale_profile) {
    return {
      ok: false, actions, code: 'STALE_RESUME',
      message: 'The tailored resume could not be brought up to date with the active profile.'
    };
  }
  return { ok: true, tailored, actions, pdf_status: exported.value?.pdf?.status || '' };
}

// Builds the per-job upload authorization the execution session and the agent
// both re-check. Returns authorized:false with the honest reason whenever the
// policy forbids it or a fresh file could not be produced — filling proceeds
// without an upload in that case; it never uploads the wrong or stale file.
//
// choice 'main' (the DEFAULT) stages the user's own uploaded resume from the
// resume library. The tailored draft is experimental until a real template
// exists — it is uploaded ONLY when the user explicitly chooses it in the
// preflight ('tailored'), never as an automatic replacement of the real file.
async function prepareResumeUploadAuthorization(jobId, { choice = 'main' } = {}) {
  const preferences = normalizeSearchPreferences(readJSON(dataPath('search_preferences.json'), defaultSearchPreferences())).value;
  const policy = preferences.safety?.resume_upload_policy || 'auto';
  if (policy !== 'auto') return { authorized: false, policy, reason: 'Resume upload is turned off in your settings.' };
  const formatPreference = preferences.safety?.resume_format_preference || 'auto';
  if (choice !== 'tailored') {
    const current = normalizeResumeProfiles(readJSON(dataPath('resume_profiles.json'), defaultResumeProfiles())).value;
    const active = current.items.find(item =>
      item.resume_id === current.active_resume_profile_id || item.id === current.active_resume_profile_id) || current.items[0];
    if (!active) return { authorized: false, policy, code: 'RESUME_NOT_FOUND', reason: 'No resume exists in the library. Upload your resume first.' };
    if (!active.approved_at) return { authorized: false, policy, code: 'RESUME_NOT_APPROVED', reason: 'Approve your uploaded resume before it can be attached.' };
    let verified;
    try { verified = verifiedResumeLibraryFile(active); }
    catch (error) { return { authorized: false, policy, code: error.code || 'RESUME_FILE_MISSING', reason: error.message }; }
    const extension = path.extname(verified.filePath).toLowerCase();
    const format = extension === '.pdf' ? 'pdf' : 'docx';
    const sha256 = sha256Of(verified.content);
    const fileName = path.basename(verified.filePath);
    return {
      authorized: true,
      policy,
      resume_source: 'main',
      actions: ['staged_main_resume'],
      staged: {
        job_id: String(jobId),
        resume_source: 'main',
        resume_id: active.resume_id,
        file_name: fileName,
        docx_path: format === 'docx' ? verified.filePath : '',
        pdf_path: format === 'pdf' ? verified.filePath : '',
        sha256,
        docx_sha256: format === 'docx' ? sha256 : '',
        pdf_sha256: format === 'pdf' ? sha256 : '',
        stale_profile: false
      },
      authorization: {
        authorized: true,
        job_id: String(jobId),
        resume_source: 'main',
        resume_id: active.resume_id,
        sha256,
        file_name: fileName,
        format_preference: formatPreference
      }
    };
  }
  const fresh = await ensureFreshTailoredResume(jobId);
  if (!fresh.ok) return { authorized: false, policy, code: fresh.code, reason: fresh.message, actions: fresh.actions };
  return {
    authorized: true,
    policy,
    resume_source: 'tailored',
    actions: fresh.actions,
    staged: {
      job_id: fresh.tailored.job_id,
      resume_source: 'tailored',
      draft_id: fresh.tailored.draft_id,
      file_name: fresh.tailored.file_name,
      docx_path: fresh.tailored.docx_path,
      pdf_path: fresh.tailored.pdf_path || '',
      sha256: fresh.tailored.docx_sha256,
      docx_sha256: fresh.tailored.docx_sha256,
      pdf_sha256: fresh.tailored.pdf_sha256 || '',
      stale_profile: fresh.tailored.stale_profile
    },
    authorization: {
      authorized: true,
      job_id: String(jobId),
      resume_source: 'tailored',
      draft_id: fresh.tailored.draft_id,
      profile_version: fresh.tailored.profile_version,
      sha256: fresh.tailored.docx_sha256,
      file_name: fresh.tailored.file_name,
      format_preference: formatPreference
    }
  };
}

async function handleStartFill(req, res, jobId) {
  const job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId));
  if (!job) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  if (body.confirmed !== true) return sendJSON(res, { status: 'blocked', message: 'confirmed=true is required before opening the job URL.' }, 409);
  const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
  if (!idempotencyKey) return sendJSON(res, { status: 'error', code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'idempotency_key is required.' }, 400);
  let started;
  const requestedExecutor = typeof body.executor_mode === 'string' ? body.executor_mode.trim() : '';
  if (requestedExecutor && !['extension', 'local_browser_agent', 'browser_agent'].includes(requestedExecutor)) {
    return sendJSON(res, { status: 'error', code: 'INVALID_EXECUTOR_MODE', message: 'Executor must be Chrome Extension or Local Browser Agent.' }, 400);
  }
  const stateBeforeStart = getDashboardState();
  const current = stateBeforeStart.application_status_overrides[String(jobId)] || {};
  const applicationStatusBeforeStart = currentStatusForJob(jobId);
  const packageValue = readApplicationPackageForJob(jobId);
  const readiness = applicationExecutionReadiness(jobId, {
    state: stateBeforeStart,
    job,
    packageValue
  });
  const executor = normalizeExecutorMode(
    requestedExecutor || readiness.session?.executor_type || current.selected_executor_type || current.executor
  );
  if (readiness.session && executor !== readiness.session.executor_type) {
    return sendJSON(res, {
      status: 'blocked',
      code: 'EXECUTOR_SELECTION_MISMATCH',
      message: 'The selected fill method does not match the saved setup. Save the choice before starting.',
      session_executor_type: readiness.session.executor_type,
      requested_executor_type: executor
    }, 409);
  }
  const idempotentReplay = Boolean(readiness.session && [
    readiness.session.idempotency_key,
    ...(readiness.session.idempotency_keys || [])
  ].includes(idempotencyKey));
  if (!readiness.allowed && !idempotentReplay) {
    return sendJSON(res, {
      status: 'blocked',
      code: readiness.blockers[0]?.code || 'APPLICATION_EXECUTION_BLOCKED',
      message: 'Cannot start fill.',
      missing: readiness.blockers.map(item => item.missing),
      blockers: readiness.blockers
    }, 409);
  }
  const applicationUrl = readiness.session?.target_url || resolveApplicationPageUrl(job);
  try {
    let executionSession = readiness.session || createApplicationExecutionSession({
        applicationPackage: packageValue.application_package,
        manifest: packageValue.manifest,
        job,
        executorType: executor,
        targetUrl: applicationUrl,
        idempotencyKey
      });
    if (!readiness.session && isLocalMockAtsUrl(applicationUrl)) {
      executionSession = assertApplicationExecutionSession({
        ...executionSession,
        target_url: buildLocalMockAtsHandoffUrl(applicationUrl, {
          jobId,
          sessionId: executionSession.session_id
        })
      });
    }
    started = startApplicationExecutionSession(stateBeforeStart, {
      jobId,
      actor: 'user_dashboard_start_fill',
      idempotencyKey,
      session: executionSession,
      initialStatus: currentStatusForJob(jobId),
      recovery: applicationStatusBeforeStart === 'NEEDS_REVIEW'
    });
  } catch (error) {
    return sendJSON(res, { status: 'blocked', code: error.code || 'INVALID_APPLICATION_TRANSITION', message: error.message }, 409);
  }
  const filePath = dataPath('dashboard_state.json');
  const backup = backupFile(filePath);
  started.record.fill_started_at = started.record.fill_started_at || new Date().toISOString();
  started.record.browser_opened = false;
  started.record.executor = started.session.executor_type;
  started.record.final_submit_allowed = false;
  let browserAgent = null;
  let resumeUploadPlan = { authorized: false, policy: 'never' };
  if (started.session.executor_type === EXECUTOR_MODES.BROWSER_AGENT && !started.idempotent_replay) {
    try {
      // Authorize the resume upload for THIS job only, against a fresh file.
      // A refusal here (policy off, profile not approved, regeneration failed)
      // never blocks safe filling — it only means no upload happens.
      // Default file = the user's MAIN uploaded resume; the experimental
      // tailored draft uploads only on explicit user choice.
      const resumeChoice = body.resume_choice === 'tailored' ? 'tailored' : 'main';
      resumeUploadPlan = await prepareResumeUploadAuthorization(jobId, { choice: resumeChoice });
      started.record.resume_upload_choice = resumeChoice;
      if (resumeUploadPlan.authorized) {
        started.session = assertApplicationExecutionSession({
          ...started.session,
          safety: { ...started.session.safety, resume_upload_allowed: true },
          resume_upload_authorization: resumeUploadPlan.authorization,
          staged_resume: resumeUploadPlan.staged
        });
      }
      // Resuming after a user-completed verification uses a distinct command so
      // the agent re-checks the page URL before it fills anything.
      browserAgent = launchBrowserAgentSession({
        session: started.session,
        action: body.browser_agent_action === 'continue_after_verification'
          ? 'continue_after_verification'
          : 'retry_safe_fill'
      });
      started.session = { ...started.session, browser_agent: browserAgent };
      started.state.application_execution_sessions[started.session.session_id] = started.session;
    } catch (error) {
      const alreadyRunning = error?.message === 'Another Local Browser Agent is active. Close its browser window before starting a new session.';
      return sendJSON(res, {
        status: 'blocked', code: 'BROWSER_AGENT_START_FAILED',
        message: alreadyRunning
          ? error.message
          : 'Local Browser Agent could not start. Check browser installation and retry.'
      }, alreadyRunning ? 409 : 500);
    }
  } else if (started.session.executor_type === EXECUTOR_MODES.BROWSER_AGENT) {
    browserAgent = started.session.browser_agent || null;
  }
  started.state.application_status_overrides[String(jobId)] = started.record;
  writeJSON(filePath, started.state);
  publishDashboardEvent(applicationStatusBeforeStart === 'NEEDS_REVIEW' ? 'RETRY_STARTED' : 'EXECUTOR_STARTED', {
    job_id: String(jobId),
    application_id: started.session.application_id,
    session_id: started.session.session_id,
    status: started.record.application_status,
    message: applicationStatusBeforeStart === 'NEEDS_REVIEW'
      ? 'Safe-fill retry started in the existing fill attempt.'
      : started.session.executor_type === EXECUTOR_MODES.BROWSER_AGENT
      ? 'Local Browser Agent started.'
      : 'Chrome Extension session is ready to connect.'
  });
  sendJSON(res, {
    status: 'ok',
    record: started.record,
    application_execution_session: started.session,
    idempotent_replay: started.idempotent_replay,
    backup,
    handoff: {
      executor: started.session.executor_type,
      status: started.session.execution_status,
      job_url: started.session.executor_type === EXECUTOR_MODES.EXTENSION ? started.session.target_url : '',
      package_path: started.record.package_path || current.package_path || '',
      resume_upload: {
        authorized: resumeUploadPlan.authorized === true,
        policy: resumeUploadPlan.policy || 'never',
        reason: resumeUploadPlan.reason || '',
        file_name: resumeUploadPlan.authorization?.file_name || '',
        prepared: resumeUploadPlan.actions || []
      },
      instruction: started.session.executor_type === EXECUTOR_MODES.BROWSER_AGENT
        ? (resumeUploadPlan.authorized
          ? 'Local Browser Agent is opening a visible browser. It fills safe fields and attaches your tailored resume; review everything — final Submit remains yours.'
          : 'Local Browser Agent is opening a visible browser. Review every filled and skipped field; upload and final Submit remain manual.')
        : isLocalMockAtsUrl(applicationUrl)
          ? 'Open the localhost Mock ATS, run Safe Mock Fill, review every field, and stop before final Submit.'
          : 'Open the URL, use AI Fill Assistant, review all fields, and stop before final Submit.',
      browser_agent: browserAgent,
    },
    safety: {
      browser_opened_by_server: started.session.executor_type === EXECUTOR_MODES.BROWSER_AGENT,
      final_submit_clicked: false,
      resume_upload_authorized: resumeUploadPlan.authorized === true,
      resume_uploaded: false
    }
  });
}

async function handleFillReport(req, res, jobId) {
  if (!findJob(jobId)) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  const current = getDashboardState().application_status_overrides[String(jobId)] || {};
  if (!current.fill_started_at) return sendJSON(res, { status: 'blocked', message: 'Start AI Fill Assistant before recording a fill report.' }, 409);
  let recorded;
  try {
    recorded = recordApplicationExecutionSessionReport(getDashboardState(), {
      jobId,
      sessionId: typeof body.application_session_id === 'string'
        ? body.application_session_id
        : typeof body.session_id === 'string' ? body.session_id : '',
      actor: body.application_execution?.executor === EXECUTOR_MODES.BROWSER_AGENT
        ? 'local_browser_agent_fill_report'
        : 'chrome_extension_fill_report',
      report: body
    });
  } catch (error) {
    return sendJSON(res, { status: 'blocked', code: error.code || 'INVALID_FILL_REPORT', message: error.message }, 409);
  }
  const filePath = dataPath('dashboard_state.json');
  const backup = backupFile(filePath);
  writeJSON(filePath, recorded.state);
  if (Number(recorded.report?.total_fields_seen || 0) > 0) {
    publishDashboardEvent('FIELDS_DETECTED', {
      job_id: String(jobId), application_id: recorded.session.application_id,
      session_id: recorded.session.session_id, status: recorded.record.application_status,
      message: `${Number(recorded.report.total_fields_seen)} application fields detected.`
    });
  }
  publishDashboardEvent('SAFE_FILL_COMPLETED', {
    job_id: String(jobId), application_id: recorded.session.application_id,
    session_id: recorded.session.session_id, status: recorded.record.application_status,
    message: 'Safe filling completed. Review the remaining fields.'
  });
  if ((recorded.session.execution_attempts || []).length > 1) {
    publishDashboardEvent('RETRY_COMPLETED', {
      job_id: String(jobId), application_id: recorded.session.application_id,
      session_id: recorded.session.session_id, status: recorded.record.application_status,
      message: 'Safe-fill retry completed. Review the updated field results.'
    });
  }
  publishDashboardEvent('NEEDS_REVIEW', {
    job_id: String(jobId), application_id: recorded.session.application_id,
    session_id: recorded.session.session_id, status: recorded.record.application_status,
    message: 'Application requires user review.'
  });
  sendJSON(res, {
    status: 'ok',
    application_status: recorded.record.application_status,
    record: recorded.record,
    application_execution_session: recorded.session,
    idempotent_replay: recorded.idempotent_replay,
    backup
  });
}

// "I finished the verification, keep filling."
//
// The product never touches a CAPTCHA, Cloudflare interstitial, login form or
// MFA prompt. It pauses, the user clears it in the window that is already open,
// and then this endpoint resumes filling in the SAME browser window, the same
// persistent profile, the same page and the same application session.
//
// It deliberately delegates to the normal start-fill path: that creates a fresh
// attempt (so re-scan freshness stays correct) and reuses every existing gate.
// Because the agent process is alive, launchBrowserAgentSession writes a command
// to it instead of relaunching, which is what keeps the window and the cleared
// verification intact.
async function handleContinueAfterVerification(req, res, jobId) {
  let body = {};
  try { body = await readRequestBody(req); }
  catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_CONTINUE_REQUEST', message: error.message }, 400);
  }
  if (body.confirmed !== true) {
    return sendJSON(res, {
      status: 'blocked', code: 'VERIFICATION_CONFIRMATION_REQUIRED',
      message: 'Confirm that you completed the verification on the open page before filling continues.'
    }, 409);
  }

  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  const session = record.active_session_id
    ? state.application_execution_sessions[record.active_session_id]
    : null;
  if (!session) {
    return sendJSON(res, {
      status: 'blocked', code: 'APPLICATION_EXECUTION_SESSION_NOT_FOUND',
      message: 'This application is not open in a browser right now.',
      recommended_recovery_action: 'Start this application again.'
    }, 409);
  }
  if (normalizeExecutorMode(session.executor_type) !== EXECUTOR_MODES.BROWSER_AGENT) {
    return sendJSON(res, {
      status: 'blocked', code: 'CONTINUE_REQUIRES_BROWSER_AGENT',
      message: 'Continuing after a verification needs the browser this product opened for you.',
      recommended_recovery_action: 'Open the application page again to continue here, or finish it yourself in your own browser.'
    }, 409);
  }

  // Resuming only means anything while the window is still open; a dead agent
  // would silently relaunch and lose the verification the user just completed.
  const agentStatus = session.browser_agent?.status_path
    ? readJSON(session.browser_agent.status_path, {})
    : {};
  const liveness = sessionLivenessSnapshot(session, { agentStatus });
  if (liveness.connection_live !== true) {
    return sendJSON(res, {
      status: 'blocked', code: 'BROWSER_WINDOW_CLOSED',
      message: 'The browser window is no longer open, so the verification you completed cannot be reused.',
      recommended_recovery_action: 'Start this application again to reopen the page.'
    }, 409);
  }

  const started = await internalCall(handleStartFill, {
    confirmed: true,
    executor_type: session.executor_type,
    // A distinct key per resume so each one is its own attempt rather than an
    // idempotent replay of the attempt that hit the verification.
    idempotency_key: String(body.idempotency_key || `continue-after-verification:${jobId}:${Date.now()}`),
    browser_agent_action: 'continue_after_verification'
  }, jobId);

  if (started.status >= 400) {
    return sendJSON(res, {
      status: 'blocked',
      code: started.value?.code || 'CONTINUE_AFTER_VERIFICATION_BLOCKED',
      message: started.value?.message || 'Filling could not continue.',
      blockers: started.value?.blockers || []
    }, started.status);
  }

  return sendJSON(res, {
    status: 'ok',
    job_id: String(jobId),
    continued_in_existing_window: true,
    application_execution_session: started.value?.application_execution_session || null,
    record: started.value?.record || null,
    safety: {
      challenge_bypassed: false,
      login_performed: false,
      resume_uploaded: false,
      application_submitted: false
    }
  });
}

async function handleRequestReviewRescan(req, res, jobId) {
  if (!findJob(jobId)) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req); } catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_RESCAN_REQUEST', message: error.message }, 400);
  }
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  const session = record.active_session_id ? state.application_execution_sessions[record.active_session_id] : null;
  if (!session) {
    return sendJSON(res, {
      status: 'blocked', code: 'APPLICATION_EXECUTION_SESSION_NOT_FOUND',
      message: 'Cannot re-scan because this job has no active fill attempt.',
      current_state: currentStatusForJob(jobId), requested_action: 'review_rescan',
      allowed_actions: applicationAllowedTransitions(currentStatusForJob(jobId)),
      recommended_recovery_action: 'Build the Application Package and start AI Fill Assistant first.'
    }, 409);
  }
  if (!['NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT'].includes(session.execution_status)) {
    return sendJSON(res, {
      status: 'blocked', code: 'APPLICATION_REVIEW_RESCAN_NOT_ALLOWED',
      message: `Re-scan is available after safe filling pauses for review. Current Session: ${session.execution_status}.`,
      current_state: currentStatusForJob(jobId), requested_action: 'review_rescan',
      allowed_actions: applicationAllowedTransitions(currentStatusForJob(jobId)),
      recommended_recovery_action: 'Complete or recover the current execution attempt first.'
    }, 409);
  }
  if (normalizeExecutorMode(session.executor_type) !== EXECUTOR_MODES.BROWSER_AGENT) {
    return sendJSON(res, {
      status: 'blocked', code: 'EXTENSION_RESCAN_REQUIRES_ACTIVE_PAGE',
      message: 'Open the application page with the Chrome Extension connected, then run page review from the extension.',
      current_state: currentStatusForJob(jobId), requested_action: 'review_rescan',
      allowed_actions: ['open_application_page', 'retry_safe_fill'],
      recommended_recovery_action: 'Open the application page and reconnect the selected Chrome Extension executor.'
    }, 409);
  }
  const scanId = String(body.scan_id || `review_rescan_${Date.now()}`).replace(/[^a-zA-Z0-9._-]+/g, '_');
  let browserAgent;
  try { browserAgent = launchBrowserAgentSession({ session, action: 'review_rescan', scanId }); }
  catch (error) {
    const alreadyRunning = error?.message === 'Another Local Browser Agent is active. Close its browser window before starting a new session.';
    return sendJSON(res, {
      status: 'blocked', code: 'REVIEW_RESCAN_START_FAILED',
      message: alreadyRunning
        ? error.message
        : 'Re-scan could not start the Local Browser Agent. Check browser installation and retry.',
      current_state: currentStatusForJob(jobId), requested_action: 'review_rescan',
      allowed_actions: ['open_application_page', 'retry_safe_fill'],
      recommended_recovery_action: 'Close any other controlled browser window, then retry this re-scan.'
    }, 409);
  }
  const updatedSession = { ...session, browser_agent: browserAgent, updated_at: new Date().toISOString() };
  state.application_execution_sessions[session.session_id] = updatedSession;
  const audited = appendAuditEvent(state, {
    jobId,
    applicationId: session.application_id,
    sessionId: session.session_id,
    eventType: 'REVIEW_RESCAN_REQUESTED',
    actor: 'user_dashboard',
    fromStatus: currentStatusForJob(jobId),
    toStatus: currentStatusForJob(jobId),
    reason: 'user_requested_current_form_rescan',
    idempotencyKey: scanId,
    metadata: { scan_id: scanId, executor_type: session.executor_type }
  });
  const filePath = dataPath('dashboard_state.json');
  const backup = backupFile(filePath);
  writeJSON(filePath, audited.state);
  publishDashboardEvent('REVIEW_RESCAN_STARTED', {
    job_id: String(jobId), application_id: session.application_id,
    session_id: session.session_id, status: currentStatusForJob(jobId),
    message: 'Review re-scan started.'
  });
  return sendJSON(res, {
    status: 'accepted',
    scan_id: scanId,
    application_execution_session: updatedSession,
    browser_agent: browserAgent,
    backup,
    safety: { resume_uploaded: false, final_submit_clicked: false }
  }, 202);
}

async function handleReviewRescanReport(req, res, jobId) {
  if (!findJob(jobId)) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req); } catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_RESCAN_REPORT', message: error.message }, 400);
  }
  let recorded;
  try {
    recorded = recordApplicationReviewRescan(getDashboardState(), {
      jobId,
      sessionId: String(body.application_session_id || body.session_id || ''),
      actor: 'local_browser_agent_review_rescan',
      report: body
    });
  } catch (error) {
    return sendJSON(res, { status: 'blocked', code: error.code || 'INVALID_RESCAN_REPORT', message: error.message }, 409);
  }
  const filePath = dataPath('dashboard_state.json');
  const backup = backupFile(filePath);
  writeJSON(filePath, recorded.state);
  publishDashboardEvent('REVIEW_RESCAN_COMPLETED', {
    job_id: String(jobId), application_id: recorded.session.application_id,
    session_id: recorded.session.session_id, status: recorded.record.application_status,
    message: 'Application form review re-scan completed.'
  });
  return sendJSON(res, {
    status: 'ok',
    review_rescan: recorded.review_rescan,
    record: recorded.record,
    application_execution_session: recorded.session,
    backup
  });
}

function learningSessionForJob(jobId, sessionId) {
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  const resolvedId = String(sessionId || record.active_session_id || '');
  const session = resolvedId ? state.application_execution_sessions?.[resolvedId] : null;
  if (!session || String(session.job_id) !== String(jobId)) return null;
  return session;
}

function careerIdentityWithLearning(profile, candidate, value) {
  const identity = structuredClone(profile.identity || {});
  const links = structuredClone(identity.links || {});
  const pathKey = String(candidate.canonical_path || '');
  const direct = {
    'identity.full_name': 'full_name',
    'identity.first_name': 'first_name',
    'identity.last_name': 'last_name',
    'identity.email': 'email',
    'identity.phone': 'phone',
    'identity.current_location': 'current_location',
    'identity.country': 'country'
  };
  if (direct[pathKey]) identity[direct[pathKey]] = value;
  else if (pathKey === 'identity.links.linkedin') links.linkedin = value;
  else if (pathKey === 'identity.links.github') links.github = value;
  else if (pathKey === 'identity.links.portfolio') links.portfolio = value;
  else {
    const error = new Error('This field does not have a supported Career Brain destination.');
    error.code = 'LEARNING_DESTINATION_UNSUPPORTED';
    throw error;
  }
  identity.links = links;
  return identity;
}

function applyCareerBrainLearningDraft({ store, learningStore, session, candidate, value, now }) {
  const normalized = normalizeCareerBrainStore(store);
  const approvedId = String(session.approved_profile_version?.profile_id || '');
  const approved = normalized.profiles.find(profile => profile.id === approvedId && profile.user_approved === true);
  if (!approved) {
    const error = new Error('The approved Career Brain version attached to this fill attempt is no longer available.');
    error.code = 'APPROVED_PROFILE_VERSION_MISSING';
    throw error;
  }
  const draftId = String(learningStore.session_drafts?.[session.session_id] || '');
  const existingDraft = normalized.profiles.find(profile => profile.id === draftId && profile.state === 'draft');
  const sourceProfile = existingDraft || approved;
  const identity = careerIdentityWithLearning(sourceProfile, candidate, value);
  const fieldProvenance = {
    ...(sourceProfile.field_provenance || {}),
    [candidate.canonical_path]: {
      source: 'post_fill_confirmed_learning',
      candidate_id: candidate.candidate_id,
      source_job: session.job_id,
      source_application: session.application_id,
      source_session: session.session_id,
      user_confirmed: true,
      confirmed_at: now
    }
  };
  if (!existingDraft) {
    const created = saveCareerProfileVersion(normalized, {
      profileId: approved.id,
      changes: { identity, field_provenance: fieldProvenance },
      now
    });
    return {
      store: created.store,
      profile: created.profile,
      learningStore: {
        ...learningStore,
        session_drafts: { ...(learningStore.session_drafts || {}), [session.session_id]: created.profile.id }
      }
    };
  }
  const updated = normalizeCareerProfile({
    ...existingDraft,
    identity,
    field_provenance: fieldProvenance,
    state: 'draft',
    user_approved: false,
    approved_at: null,
    updated_at: now
  }, { now });
  return {
    store: {
      ...normalized,
      active_profile_id: updated.id,
      profiles: normalized.profiles.map(profile => profile.id === updated.id ? updated : profile)
    },
    profile: updated,
    learningStore
  };
}

async function handleLearningCandidateReport(req, res, jobId) {
  if (!findJob(jobId)) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req, { maxBytes: 2 * 1024 * 1024 }); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_LEARNING_SNAPSHOT', message: error.message }, 400); }
  const session = learningSessionForJob(jobId, body.application_session_id || body.session_id);
  if (!session) {
    return sendJSON(res, {
      status: 'blocked', code: 'APPLICATION_EXECUTION_SESSION_NOT_FOUND',
      message: 'New information must belong to this job’s active fill attempt.'
    }, 409);
  }
  const now = new Date().toISOString();
  const candidates = buildLearningCandidates({
    session,
    baselineSnapshot: body.baseline_snapshot,
    currentSnapshot: body.current_snapshot,
    now
  });
  const stored = recordLearningCandidates(readLearningCandidateStore(), candidates, { now });
  writeLearningCandidateStore(stored);
  const pending = learningCandidatesFor(stored, { sessionId: session.session_id, status: 'pending' });
  publishDashboardEvent('LEARNING_CANDIDATES_FOUND', {
    job_id: String(jobId), application_id: session.application_id,
    session_id: session.session_id, status: currentStatusForJob(jobId),
    message: pending.length ? `${pending.length} new information item(s) need review.` : 'No new reusable information was found.'
  });
  return sendJSON(res, {
    status: 'ok',
    candidate_count: candidates.length,
    pending_count: pending.length,
    values_visible_only_in_local_review: true,
    values_logged: false,
    values_added_to_execution_report: false
  });
}

function handleLearningCandidates(res, jobId) {
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  const sessionId = String(record.active_session_id || '');
  // Listed by JOB, not by the active session: restarting fill setup swaps the
  // active session id, and filtering on it silently orphaned every pending
  // answer from the previous attempt. Decisions resolve each candidate's own
  // session, so cross-session candidates stay saveable.
  const candidates = learningCandidatesFor(readLearningCandidateStore(), { jobId, status: '' });
  sendJSON(res, {
    status: 'ok',
    job_id: String(jobId),
    session_id: sessionId,
    pending_count: candidates.filter(candidate => candidate.status === 'pending').length,
    candidates
  });
}

async function handleLearningCandidateDecision(req, res, jobId, candidateId) {
  let body = {};
  try { body = await readRequestBody(req); }
  catch (error) { return sendJSON(res, { status: 'error', code: 'INVALID_LEARNING_DECISION', message: error.message }, 400); }
  const currentStore = readLearningCandidateStore();
  const existing = currentStore.candidates.find(candidate => candidate.candidate_id === String(candidateId));
  if (!existing || String(existing.job_id) !== String(jobId)) {
    return sendJSON(res, { status: 'error', code: 'LEARNING_CANDIDATE_NOT_FOUND', message: 'Learning candidate was not found.' }, 404);
  }
  const session = learningSessionForJob(jobId, existing.session_id);
  if (!session) {
    return sendJSON(res, { status: 'blocked', code: 'APPLICATION_EXECUTION_SESSION_NOT_FOUND', message: 'This new-information review no longer has an active fill attempt.' }, 409);
  }
  if (existing.risk_level === 'high' && body.decision === 'save' && body.confirmed_high_risk !== true) {
    return sendJSON(res, {
      status: 'blocked', code: 'HIGH_RISK_CONFIRMATION_REQUIRED',
      message: 'High-risk answers require explicit confirmation and default to Do not save.'
    }, 409);
  }
  const now = new Date().toISOString();
  let decided;
  try {
    decided = decideLearningCandidate(currentStore, {
      candidateId,
      decision: body.decision,
      editedValue: body.value,
      destination: body.destination,
      scope: body.scope,
      now
    });
  } catch (error) {
    return sendJSON(res, { status: 'blocked', code: error.code || 'INVALID_LEARNING_DECISION', message: error.message }, 409);
  }
  if (decided.idempotent_replay) {
    return sendJSON(res, { status: 'ok', idempotent_replay: true, candidate: decided.candidate });
  }
  if (body.decision !== 'save') {
    writeLearningCandidateStore(decided.store);
    publishDashboardEvent('LEARNING_CANDIDATE_REJECTED', {
      job_id: String(jobId), application_id: session.application_id,
      session_id: session.session_id, status: currentStatusForJob(jobId),
      message: 'The information was not saved.'
    });
    return sendJSON(res, { status: 'ok', candidate: decided.candidate, value_retained: false });
  }

  const candidate = decided.candidate;
  const job = getJobsWithOverlay().find(item => String(item.job_id) === String(jobId)) || {};
  let learningStore = decided.store;
  let saveResult = {};
  if (candidate.selected_destination === 'career_brain') {
    let updated;
    try {
      updated = applyCareerBrainLearningDraft({
        store: readCareerBrainStore(), learningStore, session, candidate, value: candidate.value, now
      });
    } catch (error) {
      return sendJSON(res, { status: 'blocked', code: error.code || 'CAREER_BRAIN_LEARNING_FAILED', message: error.message }, 409);
    }
    writeCareerBrainStore(updated.store);
    learningStore = updated.learningStore;
    saveResult = { destination: 'career_brain', draft_profile_id: updated.profile.id, draft_version: updated.profile.version, profile_review_required: true };
  } else {
    const scopeKey = candidate.selected_scope === 'employer'
      ? String(job.company || '')
      : candidate.selected_scope === 'role' ? String(job.title || '') : '';
    const answerInput = {
      original_question: candidate.original_question,
      normalized_question: candidate.normalized_question,
      answer: candidate.value,
      answer_type: candidate.answer_type,
      risk_level: candidate.risk_level,
      category: candidate.risk_level === 'high' ? 'high_risk' : 'general',
      scope: candidate.selected_scope,
      scope_key: scopeKey,
      source_job: session.job_id,
      source_application: session.application_id,
      source_url: session.target_url,
      source_portal: candidate.portal,
      question_patterns: [candidate.original_question],
      keywords: String(candidate.normalized_question || '').split(' ').filter(Boolean).slice(0, 30),
      // No forced canonical_key: normalizeAnswerRecord derives it from the
      // question (family/profile-field aware), so a learned answer merges into
      // its question family instead of living under a private hash forever.
      source: 'user_confirmed',
      user_confirmed: true,
      approved_for_real_applications: candidate.risk_level !== 'high',
      sensitive_category: candidate.risk_level === 'high' ? 'high_risk' : 'none',
      provenance: candidate.provenance
    };
    const upserted = upsertAnswerMemoryWithResult(readJSON(dataPath('question_bank.json'), { answers: [] }), answerInput, { now });
    writePrivateJSON(dataPath('question_bank.json'), upserted.memory);
    candidate.answer_memory_question_id = upserted.record?.question_id || '';
    saveResult = { destination: 'answer_memory', question_id: upserted.record?.question_id || '', canonical_key: upserted.record?.canonical_key || '', scope: candidate.selected_scope, reusable_without_confirmation: candidate.risk_level !== 'high' };
  }
  const fieldMemory = confirmFormFieldMapping(readFormFieldMemory(), candidate, { now });
  writeFormFieldMemory(fieldMemory);
  learningStore = finalizeLearningCandidate(learningStore, candidateId, saveResult, { now });
  writeLearningCandidateStore(learningStore);
  publishDashboardEvent('LEARNING_CANDIDATE_SAVED', {
    job_id: String(jobId), application_id: session.application_id,
    session_id: session.session_id, status: currentStatusForJob(jobId),
    message: candidate.selected_destination === 'career_brain'
      ? 'Saved to a new Career Brain draft. Review and approve it before reuse.'
      : 'Confirmed answer and field mapping saved for future Packages.'
  });
  return sendJSON(res, {
    status: 'ok',
    candidate: learningCandidatesFor(learningStore, { sessionId: session.session_id, jobId, status: '' })
      .find(item => item.candidate_id === candidateId),
    save_result: saveResult,
    form_field_memory_contains_candidate_value: false
  });
}

async function handleCompleteApplicationReview(req, res, jobId) {
  if (!findJob(jobId)) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req); } catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_REVIEW_REQUEST', message: error.message }, 400);
  }
  let completed;
  try {
    completed = completeApplicationReview(getDashboardState(), {
      jobId,
      sessionId: String(body.application_session_id || body.session_id || ''),
      actor: 'user_dashboard_review_confirmation',
      confirmed: body.confirmed === true
    });
  } catch (error) {
    return sendJSON(res, {
      status: 'blocked',
      code: error.code || 'APPLICATION_REVIEW_BLOCKED',
      message: error.message,
      blockers: error.blockers || [{ code: error.code || 'APPLICATION_REVIEW_BLOCKED', message: error.message }],
      current_state: currentStatusForJob(jobId),
      requested_action: 'mark_review_complete',
      allowed_actions: ['open_application_page', 'review_skipped_fields', 'retry_safe_fill', 'review_rescan'],
      recommended_recovery_action: 'Complete the listed required fields manually, then re-scan the current form.'
    }, 409);
  }
  const filePath = dataPath('dashboard_state.json');
  const backup = backupFile(filePath);
  writeJSON(filePath, completed.state);
  publishDashboardEvent('READY_FOR_MANUAL_SUBMIT', {
    job_id: String(jobId), application_id: completed.session.application_id,
    session_id: completed.session.session_id, status: completed.record.application_status,
    message: 'Review complete. The application is ready for manual submission.'
  });
  return sendJSON(res, {
    status: 'ok',
    application_status: completed.record.application_status,
    record: completed.record,
    application_execution_session: completed.session,
    review_rescan: completed.review_rescan,
    backup,
    safety: { final_submit_clicked: false, final_submit_allowed: false }
  });
}

async function handleCancelApplication(req, res, jobId) {
  if (!findJob(jobId)) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req); } catch (error) {
    return sendJSON(res, { status: 'error', code: 'INVALID_CANCEL_REQUEST', message: error.message }, 400);
  }
  if (body.confirmed !== true) {
    return sendJSON(res, {
      status: 'blocked', code: 'CANCEL_CONFIRMATION_REQUIRED',
      message: 'confirmed=true is required before cancelling this local application execution.'
    }, 409);
  }
  const state = getDashboardState();
  const record = state.application_status_overrides[String(jobId)] || {};
  const currentStatus = currentStatusForJob(jobId);
  if (currentStatus === 'MANUALLY_SUBMITTED') {
    return sendJSON(res, {
      status: 'blocked', code: 'MANUALLY_SUBMITTED_APPLICATION_LOCKED',
      message: 'A manually submitted application cannot be cancelled from Resume Jobs.',
      current_state: currentStatus, requested_action: 'cancel_application', allowed_actions: []
    }, 409);
  }
  let transitioned;
  try {
    transitioned = transitionApplicationState(state, {
      jobId,
      toStatus: 'CANCELLED',
      actor: 'user_dashboard_cancel_application',
      reason: String(body.reason || 'user_cancelled_application'),
      patch: {
        cancelled_at: new Date().toISOString(),
        cancelled_by: 'user_dashboard',
        final_submit_allowed: false
      },
      initialStatus: currentStatus,
      idempotencyKey: String(body.idempotency_key || `cancel:${jobId}:${Date.now()}`),
      sessionId: record.active_session_id || ''
    });
  } catch (error) {
    return sendJSON(res, {
      status: 'blocked', code: error.code || 'INVALID_APPLICATION_TRANSITION', message: error.message,
      current_state: error.from_status || currentStatus, requested_action: 'cancel_application',
      allowed_actions: applicationAllowedTransitions(error.from_status || currentStatus),
      recommended_recovery_action: 'Review the current application state and use its explicit recovery action.'
    }, 409);
  }
  if (record.active_session_id && transitioned.state.application_execution_sessions[record.active_session_id]) {
    transitioned.state.application_execution_sessions[record.active_session_id] = transitionApplicationExecutionSession(
      transitioned.state.application_execution_sessions[record.active_session_id],
      'CANCELLED',
      { details: { reason: 'user_cancelled_application' } }
    );
  }
  const filePath = dataPath('dashboard_state.json');
  const backup = backupFile(filePath);
  writeJSON(filePath, transitioned.state);
  publishDashboardEvent('APPLICATION_CANCELLED', {
    job_id: String(jobId), application_id: transitioned.record.application_id,
    session_id: record.active_session_id || '', status: 'CANCELLED',
    message: 'Application execution cancelled. Job history and package were preserved.'
  });
  return sendJSON(res, {
    status: 'ok', record: transitioned.record, backup, audit_event: transitioned.event,
    next_action: 'Restore the job to review when you are ready to reconsider it.',
    safety: { final_submit_clicked: false, resume_uploaded: false }
  });
}

async function handleMarkSubmitted(req, res, jobId) {
  if (!findJob(jobId)) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);
  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }
  if (body.confirmed !== true) return sendJSON(res, { status: 'blocked', message: 'confirmed=true is required after the user submits manually.' }, 409);
  const statusBeforeSubmit = currentStatusForJob(jobId);
  if (!USER_DECLARABLE_SUBMIT_STATUSES.has(statusBeforeSubmit)) {
    return sendJSON(res, {
      status: 'blocked',
      message: 'This application is not in a state where a manual submission can be declared.',
      current_state: statusBeforeSubmit
    }, 409);
  }
  try {
    const transitioned = persistApplicationTransition(jobId, 'MANUALLY_SUBMITTED', {
      actor: 'user_dashboard_manual_submission_confirmation',
      reason: 'user_confirmed_manual_submit',
      patch: {
        manually_submitted_at: new Date().toISOString(),
        manually_submitted_confirmed: true
      }
    });
    const sessionId = transitioned.record.active_session_id || '';
    const activeSession = sessionId ? transitioned.state.application_execution_sessions[sessionId] : null;
    if (activeSession) {
      // The user's declaration ends the fill attempt. A session that already
      // reached its own terminal state keeps that record — it describes what
      // the executor actually did, which may differ from what the user did.
      if (!['COMPLETE', 'CANCELLED', 'FAILED'].includes(String(activeSession.execution_status))) {
        transitioned.state.application_execution_sessions[sessionId] = transitionApplicationExecutionSession(
          activeSession,
          'COMPLETE',
          { details: { reason: 'user_confirmed_manual_submission' } }
        );
      }
      writeJSON(dataPath('dashboard_state.json'), transitioned.state);
    }
    publishDashboardEvent('MANUALLY_SUBMITTED', {
      job_id: String(jobId), application_id: transitioned.record.application_id,
      session_id: sessionId, status: transitioned.record.application_status,
      message: 'Application marked as manually submitted.'
    });
    sendJSON(res, { status: 'ok', record: transitioned.record, backup: transitioned.backup, audit_event: transitioned.event });
  } catch (error) {
    sendJSON(res, { status: 'blocked', code: error.code || 'INVALID_APPLICATION_TRANSITION', message: error.message }, 409);
  }
}

async function handleApplicationStatus(req, res, jobId, status) {
  if (!VALID_APPLICATION_STATUSES.has(status)) {
    return sendJSON(res, { status: 'error', message: 'Invalid application status' }, 400);
  }
  if (!findJob(jobId)) return sendJSON(res, { status: 'error', message: 'Job not found' }, 404);

  let body = {};
  try { body = await readRequestBody(req); } catch (err) { return sendJSON(res, { status: 'error', message: err.message }, 400); }

  let targetStatus;
  try { targetStatus = normalizeApplicationStatus(status); }
  catch (error) { return sendJSON(res, { status: 'error', code: error.code, message: error.message }, 400); }
  let transitioned;
  try {
    transitioned = persistApplicationTransition(jobId, targetStatus, {
      actor: 'user_dashboard',
      reason: `legacy_status_action_${status}`,
      patch: { notes: typeof body.notes === 'string' ? body.notes : '' }
    });
  } catch (error) {
    return sendJSON(res, { status: 'blocked', code: error.code || 'INVALID_APPLICATION_TRANSITION', message: error.message }, 409);
  }

  sendJSON(res, {
    status: 'ok',
    record: transitioned.record,
    backup: transitioned.backup,
    audit_event: transitioned.event,
    safety: {
      browser_opened: false,
      chrome_extension_called: false,
      apply_submit_clicked: false,
      resume_uploaded: false,
      application_submitted: false
    }
  });
}

function isTrustedBrowserOrigin(origin) {
  if (/^chrome-extension:\/\/[a-p]{32}$/i.test(origin)) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(parsed.hostname.toLowerCase())
      && parsed.port === String(PORT);
  } catch {
    return false;
  }
}

function configureCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (!origin) return;
  if (!isTrustedBrowserOrigin(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function configureBrowserSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
}

const server = http.createServer(async (req, res) => {
  configureBrowserSecurityHeaders(res);
  let url;
  let pathname;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJSON(res, {
      status: 'error', code: 'INVALID_REQUEST_URL',
      message: 'The request URL is not valid. Reload the Dashboard and try again.'
    }, 400);
  }
  console.log(`${req.method} ${pathname}`);
  configureCors(req, res);
  const requestOrigin = String(req.headers.origin || '');
  const mutatesLocalState = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase());
  if (mutatesLocalState && requestOrigin && !isTrustedBrowserOrigin(requestOrigin)) {
    return sendJSON(res, {
      status: 'blocked', code: 'UNTRUSTED_REQUEST_ORIGIN',
      message: 'This local action is available only from the Resume Jobs Dashboard or browser extension.'
    }, 403);
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    if (pathname === '/api/runtime/shutdown' && req.method === 'POST') {
      const suppliedToken = String(req.headers['x-resume-jobs-shutdown-token'] || '');
      if (!SHUTDOWN_TOKEN || suppliedToken !== SHUTDOWN_TOKEN) {
        return sendJSON(res, { status: 'not_found' }, 404);
      }
      sendJSON(res, { status: 'stopping' });
      setImmediate(() => { void shutdownDashboard(); });
      return;
    }
    if (pathname === '/api/events' && req.method === 'GET') return handleDashboardEvents(req, res);
    if (pathname === '/api/summary' && req.method === 'GET') return handleSummary(res);
    if (pathname === '/api/jobs' && req.method === 'GET') return handleJobs(res);
    if (pathname === '/api/jobs/clear-search-records' && req.method === 'POST') return await handleClearSearchRecords(req, res);
    if (pathname === '/api/provider-health' && req.method === 'GET') return handleProviderHealth(res);
    if (pathname === '/api/daily-automation/latest' && req.method === 'GET') return handleDailyAutomationLatest(res);
    if (pathname === '/api/settings' && req.method === 'GET') return handleSettings(res);
    if (pathname === '/api/career-brain' && req.method === 'GET') return handleCareerBrain(res);
    if (pathname === '/api/career-brain/profiles' && req.method === 'POST') return await handleCareerBrainProfileAction(req, res);
    const careerProfileExportMatch = pathname.match(/^\/api\/career-brain\/profiles\/([^/]+)\/export$/);
    if (careerProfileExportMatch && req.method === 'GET') return handleExportCareerProfile(res, careerProfileExportMatch[1]);
    if (pathname === '/api/workflow-state' && req.method === 'GET') return handleProductWorkflowState(res);
    if (pathname === '/api/workflow' && req.method === 'GET') return handleWorkflow(res);
    if (pathname === '/api/extension/active-hosts' && req.method === 'GET') return handleExtensionActiveHosts(req, res);
    if (pathname === '/api/extension/active-handoff' && req.method === 'GET') return handleExtensionActiveHandoff(req, res, url.searchParams.get('url') || '');
    if (pathname === '/api/extension/diagnostics' && req.method === 'GET') return handleGetExtensionDiagnostics(res);
    if (pathname === '/api/extension/diagnostics' && req.method === 'POST') return await handlePostExtensionDiagnostics(req, res);
    if (pathname === '/api/executor/status' && req.method === 'GET') return handleExecutorStatus(res, url.searchParams.get('job_id') || '');
    if (pathname === '/api/executor-capabilities' && req.method === 'GET') return handleExecutorCapabilities(res);
    if (pathname === '/api/application-profile' && req.method === 'GET') return handleGetApplicationProfile(res);
    if (pathname === '/api/application-profile' && req.method === 'PUT') return await handlePutApplicationProfile(req, res);
    if (pathname === '/api/profile/full' && req.method === 'GET') return handleGetFullProfile(res);
    if (pathname === '/api/profile/undo' && req.method === 'POST') return await handleUndoProfileVersion(req, res);
    const checklistMatch = pathname.match(/^\/api\/applications\/([^/]+)\/checklist$/);
    if (checklistMatch && req.method === 'GET') return handleApplicationChecklist(res, checklistMatch[1]);
    const applyStateMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/apply-state$/);
    if (applyStateMatch && req.method === 'GET') return handleApplyState(res, applyStateMatch[1]);
    const resumeDraftExportMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/resume-draft\/export$/);
    if (resumeDraftExportMatch && req.method === 'POST') return await handleExportResumeDraft(req, res, resumeDraftExportMatch[1]);
    const resumeDraftFileMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/resume-draft\/file$/);
    if (resumeDraftFileMatch && req.method === 'GET') {
      return handleDownloadResumeDraftFile(res, resumeDraftFileMatch[1], url.searchParams.get('format') || 'docx');
    }
    const resumeDraftMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/resume-draft$/);
    if (resumeDraftMatch && req.method === 'POST') return await handleGenerateResumeDraft(req, res, resumeDraftMatch[1]);
    if (resumeDraftMatch && req.method === 'GET') return handleGetResumeDraft(res, resumeDraftMatch[1]);
    if (resumeDraftMatch && req.method === 'DELETE') return handleDeleteResumeDraft(res, resumeDraftMatch[1]);
    const coverLetterMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cover-letter$/);
    if (coverLetterMatch && req.method === 'POST') return await handleGenerateCoverLetter(req, res, coverLetterMatch[1]);
    if (coverLetterMatch && req.method === 'GET') return handleGetCoverLetter(res, coverLetterMatch[1]);
    if (coverLetterMatch && req.method === 'DELETE') return handleDeleteCoverLetter(res, coverLetterMatch[1]);
    const quickApplyStartMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/quick-apply\/start$/);
    if (quickApplyStartMatch && req.method === 'POST') return await handleQuickApplyStart(req, res, quickApplyStartMatch[1]);
    const openAnswersMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/open-answers$/);
    if (openAnswersMatch && req.method === 'POST') return await handleSaveOpenAnswers(req, res, openAnswersMatch[1]);
    const quickApplyMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/quick-apply$/);
    if (quickApplyMatch && req.method === 'POST') return await handleQuickApply(req, res, quickApplyMatch[1]);
    if (pathname === '/api/extension/local-state' && req.method === 'GET') return handleExtensionLocalState(req, res);
    if (pathname === '/api/audit' && req.method === 'GET') return handleApplicationAudit(res, url.searchParams.get('job_id') || '');
    if (pathname === '/api/settings/search-preferences' && req.method === 'POST') return await handleSaveSearchPreferences(req, res);
    if (pathname === '/api/settings/job-search-sources' && req.method === 'POST') return await handleSaveJobSearchSources(req, res);
    if (pathname === '/api/settings/job-search-sources/test' && req.method === 'POST') return await handleTestJobSearchProvider(req, res);
    if (pathname === '/api/settings/ai-provider' && req.method === 'POST') return await handleSaveAIProvider(req, res);
    if (pathname === '/api/settings/ai-provider/test' && req.method === 'POST') return await handleTestAIProvider(req, res);
    if (pathname === '/api/settings/reset-local-data' && req.method === 'POST') return await handleResetLocalData(req, res);
    if (pathname === '/api/data/clear-job-materials' && req.method === 'POST') return await handleClearJobMaterials(req, res);
    if (pathname === '/api/ai/detect-local' && req.method === 'GET') return await handleDetectLocalAI(res);
    if (pathname === '/api/settings/resume-profiles' && req.method === 'POST') return await handleSaveResumeProfiles(req, res);
    if (pathname === '/api/settings/resume-upload' && req.method === 'POST') return await handleResumeUpload(req, res);
    const resumeManageMatch = pathname.match(/^\/api\/settings\/resume-profiles\/([^/]+)\/manage$/);
    if (resumeManageMatch && req.method === 'POST') {
      return await handleManageResumeProfile(req, res, resumeManageMatch[1]);
    }
    const resumeExportMatch = pathname.match(/^\/api\/settings\/resume-profiles\/([^/]+)\/export$/);
    if (resumeExportMatch && req.method === 'GET') {
      return handleExportResumeProfile(res, resumeExportMatch[1]);
    }
    const resumeApprovalMatch = pathname.match(/^\/api\/settings\/resume-profiles\/([^/]+)\/approve$/);
    if (resumeApprovalMatch && req.method === 'POST') {
      return await handleApproveResumeProfile(req, res, resumeApprovalMatch[1]);
    }
    const resumeAnalysisMatch = pathname.match(/^\/api\/settings\/resume-profiles\/([^/]+)\/analyze$/);
    if (resumeAnalysisMatch && req.method === 'POST') {
      return await handleAnalyzeResumeProfile(req, res, resumeAnalysisMatch[1]);
    }
    const resumeSuggestionMatch = pathname.match(/^\/api\/settings\/resume-profiles\/([^/]+)\/apply-suggestions$/);
    if (resumeSuggestionMatch && req.method === 'POST') {
      return await handleApplyResumeSuggestions(req, res, resumeSuggestionMatch[1]);
    }
    if (pathname === '/api/settings/question-answer' && req.method === 'POST') return await handleSaveQuestionAnswer(req, res);
    if (pathname === '/api/answers' && req.method === 'GET') return handleListAnswers(req, res, url);
    if (pathname === '/api/answers' && req.method === 'POST') return await handleSaveQuestionAnswer(req, res);
    const answerMatch = pathname.match(/^\/api\/answers\/([^/]+)$/);
    if (answerMatch && req.method === 'GET') return handleGetAnswer(req, res, answerMatch[1]);
    if (answerMatch && req.method === 'PUT') return await handleUpdateAnswer(req, res, answerMatch[1]);
    if (answerMatch && req.method === 'DELETE') return handleDeleteAnswer(req, res, answerMatch[1]);
    if (pathname === '/api/settings/candidate-profile/facts' && req.method === 'POST') return await handleCandidateFactMutation(req, res);
    if (pathname === '/api/settings/candidate-profile/confirm' && req.method === 'POST') return await handleConfirmCandidateFacts(req, res);
    if (pathname === '/api/settings/candidate-profile/versions' && req.method === 'POST') return await handleCandidateProfileVersion(req, res);
    if (pathname === '/api/workflow/selection' && req.method === 'POST') return await handleSaveWorkflowSelection(req, res);

    if (pathname === '/api/run/discovery' && req.method === 'POST') return await handleRun(res, 'discovery');
    if (pathname === '/api/jobs/import-url' && req.method === 'POST') return await handleImportJobUrl(req, res);
    if (pathname === '/api/jobs/import' && req.method === 'POST') return await handleUnifiedJobImport(req, res);
    if (pathname === '/api/jobs/search' && req.method === 'POST') return await handleJobKeywordSearch(req, res);
    if (pathname === '/api/jobs/discover-in-browser' && req.method === 'POST') return await handleDiscoverInBrowser(req, res);
    if (pathname === '/api/jobs/discover-in-browser/status' && req.method === 'GET') return handleDiscoverInBrowserStatus(res);
    if (pathname === '/api/jobs/discover-in-browser/continue' && req.method === 'POST') return handleDiscoverInBrowserContinue(res);
    if (pathname === '/api/search/profile-directions' && req.method === 'GET') return handleProfileDirections(res);
    if (pathname === '/api/search/plans' && req.method === 'GET') return handleListSearchPlans(res);
    if (pathname === '/api/search/plans' && req.method === 'POST') return await handleSaveSearchPlan(req, res);
    const searchPlanMatch = pathname.match(/^\/api\/search\/plans\/([^/]+)$/);
    if (searchPlanMatch && req.method === 'DELETE') return handleDeleteSearchPlan(res, searchPlanMatch[1]);
    if (pathname === '/api/search/run' && req.method === 'POST') return await handleRunGlobalSearch(req, res);
    if (pathname === '/api/search/run/status' && req.method === 'GET') return handleGlobalSearchStatus(res);
    if (pathname === '/api/search/run/stop' && req.method === 'POST') return handleStopGlobalSearch(res);
    const flagMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/flag$/);
    if (flagMatch && req.method === 'POST') return await handleJobFlag(req, res, flagMatch[1]);
    if (pathname === '/api/jobs/import-company-careers' && req.method === 'POST') return await handleImportCompanyCareers(req, res);
    if (pathname === '/api/ai/status' && req.method === 'GET') return handleAIStatus(res);
    if (pathname === '/api/applications/history' && req.method === 'GET') return handleApplicationsHistory(res);
    if (pathname === '/api/run/offline-demo-discovery' && req.method === 'POST') return handleOfflineDemoDiscovery(res);
    if (pathname === '/api/run/scoring' && req.method === 'POST') return await handleRun(res, 'scoring');
    if (pathname === '/api/run/ai-enrichment' && req.method === 'POST') return await handleRun(res, 'ai-enrichment');
    if (pathname === '/api/run/approval-queue' && req.method === 'POST') return await handleRun(res, 'approval-queue');

    const decisionMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/(approve|reject|save|manual-review|restore|reconsider|reset)$/);
    if (decisionMatch && req.method === 'POST') {
      const map = {
        approve: 'approved', reject: 'rejected', save: 'manual_review',
        'manual-review': 'manual_review', restore: 'restore', reconsider: 'reconsider', reset: 'restore'
      };
      return await handleDecision(req, res, decisionMatch[1], map[decisionMatch[2]]);
    }

    const packageMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/build-package-preview$/);
    if (packageMatch && req.method === 'POST') {
      return await handleBuildPackagePreview(req, res, packageMatch[1]);
    }

    const packageReadMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/application-package$/);
    if (packageReadMatch && req.method === 'GET') return handleApplicationPackage(res, packageReadMatch[1]);

    const recoverExecutionMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/recover-execution$/);
    if (recoverExecutionMatch && req.method === 'POST') {
      return await handleRecoverApplicationExecution(req, res, recoverExecutionMatch[1]);
    }

    const executorSelectionMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/executor-selection$/);
    if (executorSelectionMatch && req.method === 'POST') {
      return await handleExecutorSelection(req, res, executorSelectionMatch[1]);
    }

    const restartFillSetupMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/restart-fill-setup$/);
    if (restartFillSetupMatch && req.method === 'POST') {
      return await handleRestartFillSetup(req, res, restartFillSetupMatch[1]);
    }

    const approveFillMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/approve-fill$/);
    if (approveFillMatch && req.method === 'POST') return await handleApproveFill(req, res, approveFillMatch[1]);

    const startFillMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/start-fill$/);
    if (startFillMatch && req.method === 'POST') return await handleStartFill(req, res, startFillMatch[1]);

    const fillReportMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/fill-report$/);
    if (fillReportMatch && req.method === 'POST') return await handleFillReport(req, res, fillReportMatch[1]);

    const fillCurrentStepMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/fill-current-step$/);
    if (fillCurrentStepMatch && req.method === 'POST') return handleFillCurrentStep(req, res, fillCurrentStepMatch[1]);

    const continueAfterVerificationMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/continue-after-verification$/);
    if (continueAfterVerificationMatch && req.method === 'POST') {
      return await handleContinueAfterVerification(req, res, continueAfterVerificationMatch[1]);
    }

    const reviewRescanMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/review-rescan$/);
    if (reviewRescanMatch && req.method === 'POST') return await handleRequestReviewRescan(req, res, reviewRescanMatch[1]);

    const reviewRescanReportMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/review-rescan-report$/);
    if (reviewRescanReportMatch && req.method === 'POST') return await handleReviewRescanReport(req, res, reviewRescanReportMatch[1]);

    const learningCandidateReportMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/learning-candidates\/report$/);
    if (learningCandidateReportMatch && req.method === 'POST') return await handleLearningCandidateReport(req, res, learningCandidateReportMatch[1]);

    const learningCandidatesMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/learning-candidates$/);
    if (learningCandidatesMatch && req.method === 'GET') return handleLearningCandidates(res, learningCandidatesMatch[1]);

    const learningCandidateDecisionMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/learning-candidates\/([^/]+)\/decision$/);
    if (learningCandidateDecisionMatch && req.method === 'POST') {
      return await handleLearningCandidateDecision(req, res, learningCandidateDecisionMatch[1], learningCandidateDecisionMatch[2]);
    }

    const reviewCompleteMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/review-complete$/);
    if (reviewCompleteMatch && req.method === 'POST') return await handleCompleteApplicationReview(req, res, reviewCompleteMatch[1]);

    const cancelApplicationMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel-application$/);
    if (cancelApplicationMatch && req.method === 'POST') return await handleCancelApplication(req, res, cancelApplicationMatch[1]);

    if (pathname === '/mock-ats/jobs/123456' && req.method === 'GET') {
      return sendFile(
        res,
        path.join(PROJECT_ROOT, 'mock_sites', 'job_apply_autofill_test', 'index.html'),
        'text/html; charset=utf-8'
      );
    }

    const submittedMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/submitted-manually$/);
    if (submittedMatch && req.method === 'POST') return await handleMarkSubmitted(req, res, submittedMatch[1]);

    const appMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/(package-ready|autofill-tested|failed)$/);
    if (appMatch && req.method === 'POST') {
      const map = {
        'package-ready': 'PACKAGE_READY',
        'autofill-tested': 'NEEDS_REVIEW',
        failed: 'RECOVERY_REQUIRED'
      };
      return await handleApplicationStatus(req, res, appMatch[1], map[appMatch[2]]);
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!pathname.startsWith('/api/') && (req.method === 'GET' || req.method === 'HEAD')) {
      return handleStaticRequest(req, res, pathname);
    }

    return sendNotFound(req, res, pathname);
  } catch (err) {
    const safeCode = err?.code === 'LOCAL_DATA_READ_FAILED'
      ? 'LOCAL_DATA_READ_FAILED'
      : 'INTERNAL_DASHBOARD_ERROR';
    console.error(JSON.stringify({
      event: 'dashboard_request_failed',
      method: req.method,
      path: pathname,
      error_name: String(err?.name || 'Error'),
      error_code: String(err?.code || 'UNEXPECTED_ERROR')
    }));
    sendJSON(res, {
      status: 'error', code: safeCode,
      message: safeCode === 'LOCAL_DATA_READ_FAILED'
        ? err.message
        : 'The Dashboard could not complete this action. Try again; if it continues, check Advanced diagnostics.'
    }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard server running at http://${HOST}:${PORT}/`);
  console.log('Safe mode: local JSON only; no browser automation; no auto-submit.');
  console.log('Press Ctrl+C to stop');
});

let dashboardShutdownStarted = false;

async function shutdownDashboard() {
  if (dashboardShutdownStarted) return;
  dashboardShutdownStarted = true;
  const children = [...browserAgentProcesses.values()].filter(child => child && child.exitCode === null);
  const stopped = children.map(child => new Promise(resolve => {
    // Closing a persistent Chromium profile can take several seconds on
    // Windows while Crashpad releases its handles. Wait for the owned Browser
    // Agent instead of exiting early and orphaning that process tree.
    const timer = setTimeout(resolve, 10_000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  }));
  await new Promise(resolve => server.close(resolve));
  await Promise.all(stopped);
  process.exit(0);
}

process.once('SIGTERM', () => { void shutdownDashboard(); });
process.once('SIGINT', () => { void shutdownDashboard(); });
