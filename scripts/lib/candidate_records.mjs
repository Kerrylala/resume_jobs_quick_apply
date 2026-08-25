import crypto from 'node:crypto';
import { zipEntryNames } from './resume_document_intelligence.mjs';
import '../../application_executor/shared_core.js';

const executorCore = globalThis.ResumeJobsApplicationExecutorCore;

const ANSWER_SOURCES = new Set(['user_entered', 'user_confirmed', 'resume_derived', 'historical_confirmed', 'model_suggested']);
export const MAX_RESUME_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_RESUME_EXTENSIONS = new Set(['.pdf', '.docx', '.txt']);

export class ResumeUploadValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResumeUploadValidationError';
    this.code = code;
  }
}

function text(value) {
  return String(value ?? '').trim();
}

function list(value) {
  return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
}

function normalizedMatchText(value) {
  return text(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jobMatchText(job = {}) {
  return normalizedMatchText([
    job.title,
    job.description,
    job.description_text,
    job.summary,
    job.department,
    ...(Array.isArray(job.skills) ? job.skills : []),
    ...(Array.isArray(job.match_reasons) ? job.match_reasons : []),
    ...(Array.isArray(job.matched_target_roles) ? job.matched_target_roles : [])
  ].filter(Boolean).join(' '));
}

function resumeEligibility(item) {
  const reasons = [];
  if (item.enabled === false) reasons.push('disabled');
  if (!item.approved_at) reasons.push('not_user_approved');
  if (!item.content_hash) reasons.push('content_not_verified');
  if (!item.file_reference) reasons.push('file_reference_missing');
  if (item.resume_file_status && item.resume_file_status !== 'exists') reasons.push('local_file_unavailable');
  return { eligible: reasons.length === 0, reasons };
}

function scoreResumeForJob(item, job, activeResumeId) {
  const title = normalizedMatchText(job?.title);
  const haystack = jobMatchText(job);
  const reasons = [];
  let roleScore = 0;
  for (const roleValue of item.target_roles || []) {
    const role = normalizedMatchText(roleValue);
    if (!role) continue;
    let points = 0;
    let kind = '';
    if (title && title === role) {
      points = 60;
      kind = 'exact_title_role_match';
    } else if (title && (title.includes(role) || role.includes(title))) {
      points = 45;
      kind = 'title_role_match';
    } else if (haystack.includes(role)) {
      points = 25;
      kind = 'job_text_role_match';
    }
    if (points > roleScore) {
      roleScore = points;
      reasons.splice(0, reasons.length, { kind, value: roleValue, points });
    }
  }

  const matchedSkills = [];
  for (const skillValue of item.skills || []) {
    const skill = normalizedMatchText(skillValue);
    if (skill && haystack.includes(skill)) matchedSkills.push(skillValue);
  }
  const skillScore = Math.min(32, matchedSkills.length * 8);
  if (skillScore) {
    reasons.push({
      kind: 'skill_overlap',
      values: matchedSkills,
      points: skillScore
    });
  }

  const activeBonus = item.resume_id === activeResumeId ? 3 : 0;
  if (activeBonus) reasons.push({ kind: 'active_resume_tiebreaker', points: activeBonus });
  return {
    resume_id: item.resume_id,
    name: item.name,
    version: item.version,
    score: Math.min(100, roleScore + skillScore + activeBonus),
    role_score: roleScore,
    skill_score: skillScore,
    matched_skills: matchedSkills,
    is_active: item.resume_id === activeResumeId,
    reasons
  };
}

export function selectBestResumeProfile(resumeProfiles, job = {}, {
  preferredResumeId = ''
} = {}) {
  const resumes = normalizeResumeProfiles(resumeProfiles).value;
  const activeResumeId = resumes.active_resume_id;
  const allCandidates = resumes.items.map(item => {
    const eligibility = resumeEligibility(item);
    return {
      item,
      eligibility,
      ranking: eligibility.eligible ? scoreResumeForJob(item, job, activeResumeId) : null
    };
  });
  const eligible = allCandidates
    .filter(candidate => candidate.eligibility.eligible)
    .sort((left, right) =>
      right.ranking.score - left.ranking.score
      || Number(right.ranking.is_active) - Number(left.ranking.is_active)
      || right.ranking.version - left.ranking.version
      || left.ranking.resume_id.localeCompare(right.ranking.resume_id)
    );
  const recommended = eligible[0] || null;
  const preferredId = text(preferredResumeId);
  const overridden = preferredId
    ? allCandidates.find(candidate => candidate.item.resume_id === preferredId) || null
    : null;
  const preferredEligible = overridden?.eligibility.eligible === true;
  const selected = preferredId ? (preferredEligible ? overridden : null) : recommended;
  const meaningfulMatch = Boolean(recommended?.ranking.role_score || recommended?.ranking.skill_score);

  return {
    selected_resume: selected?.item || null,
    recommended_resume: recommended?.item || null,
    selection: {
      mode: preferredId
        ? (preferredEligible ? 'user_override' : 'invalid_user_override')
        : (recommended ? (meaningfulMatch ? 'recommended' : 'active_fallback') : 'no_eligible_resume'),
      selected_resume_id: selected?.item.resume_id || '',
      recommended_resume_id: recommended?.item.resume_id || '',
      requested_resume_id: preferredId,
      confidence: !recommended
        ? 0
        : (recommended.ranking.role_score >= 45 ? 0.95 : recommended.ranking.score >= 25 ? 0.8 : 0.6),
      reasons: selected?.ranking?.reasons || [],
      candidates: allCandidates.map(candidate => ({
        resume_id: candidate.item.resume_id,
        name: candidate.item.name,
        version: candidate.item.version,
        eligible: candidate.eligibility.eligible,
        ineligible_reasons: candidate.eligibility.reasons,
        score: candidate.ranking?.score ?? null,
        reasons: candidate.ranking?.reasons || []
      }))
    }
  };
}

function uploadError(code, message) {
  throw new ResumeUploadValidationError(code, message);
}

function slug(value) {
  return text(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'resume';
}

function validateBase64(value) {
  const encoded = text(value);
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    uploadError('INVALID_RESUME_CONTENT', 'Resume content must be valid base64.');
  }
  if (encoded.length > Math.ceil(MAX_RESUME_UPLOAD_BYTES / 3) * 4 + 4) {
    uploadError('RESUME_FILE_TOO_LARGE', `Resume file must not exceed ${MAX_RESUME_UPLOAD_BYTES} bytes.`);
  }
  return encoded;
}

export function resumeContentHash(content) {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

export function matchesResumeContentHash(content, expectedHash) {
  return text(expectedHash) !== '' && resumeContentHash(content) === text(expectedHash);
}

export function validateResumeUpload(input = {}) {
  const fileName = text(input.file_name || input.filename);
  const extension = pathExtension(fileName);
  if (!fileName || !ALLOWED_RESUME_EXTENSIONS.has(extension)) {
    uploadError('UNSUPPORTED_RESUME_TYPE', 'Only PDF, DOCX, and TXT resume files are supported.');
  }
  const encoded = validateBase64(input.content_base64);
  const content = Buffer.from(encoded, 'base64');
  if (!content.length) uploadError('EMPTY_RESUME_FILE', 'Resume file is empty.');
  if (content.length > MAX_RESUME_UPLOAD_BYTES) {
    uploadError('RESUME_FILE_TOO_LARGE', `Resume file must not exceed ${MAX_RESUME_UPLOAD_BYTES} bytes.`);
  }
  if (extension === '.pdf' && content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    uploadError('RESUME_SIGNATURE_MISMATCH', 'The selected file does not have a valid PDF signature.');
  }
  if (extension === '.docx') {
    const signature = content.subarray(0, 4);
    const zipSignature = signature.length === 4 && signature.readUInt32LE(0) === 0x04034b50;
    let names = [];
    try { names = zipEntryNames(content); }
    catch {
      // The signature check below returns the same bounded validation error for
      // a corrupt ZIP directory without exposing document bytes.
      names = [];
    }
    if (!zipSignature || !names.includes('[Content_Types].xml') || !names.includes('word/document.xml')) {
      uploadError('RESUME_SIGNATURE_MISMATCH', 'The selected file does not have a valid DOCX container signature.');
    }
  }
  if (extension === '.txt') {
    let decoded;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      uploadError('INVALID_RESUME_TEXT_ENCODING', 'TXT resume files must use valid UTF-8 text encoding.');
    }
    const withoutBom = decoded.replace(/^\uFEFF/, '');
    const controlCharacters = [...withoutBom].filter(character => {
      const code = character.codePointAt(0);
      return code < 32 && !['\t', '\n', '\r'].includes(character);
    }).length;
    if (!withoutBom.trim() || withoutBom.includes('\u0000') || controlCharacters > Math.max(2, withoutBom.length * 0.01)) {
      uploadError('INVALID_RESUME_TEXT_CONTENT', 'TXT resume must contain readable plain text, not binary content.');
    }
  }
  return {
    file_name: pathBaseName(fileName),
    extension,
    content,
    size_bytes: content.length,
    content_hash: resumeContentHash(content)
  };
}

function pathBaseName(value) {
  return String(value || '').replaceAll('\\', '/').split('/').at(-1) || '';
}

function pathExtension(value) {
  const name = pathBaseName(value).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}

export function buildUploadedResumeProfile(existingProfiles, {
  fileName,
  displayName = '',
  fileReference = '',
  contentHash,
  targetRoles = [],
  language = '',
  profileFilePath = '',
  now = new Date().toISOString()
} = {}) {
  const normalized = normalizeResumeProfiles(existingProfiles).value;
  const name = text(displayName) || pathBaseName(fileName).replace(/\.(pdf|docx|txt)$/i, '') || 'Resume';
  const matchingVersions = normalized.items
    .filter(item => item.name.toLowerCase() === name.toLowerCase())
    .map(item => Number(item.version || 1));
  let version = matchingVersions.length ? Math.max(...matchingVersions) + 1 : 1;
  let resumeId = `${slug(name)}_v${version}`;
  const existingIds = new Set(normalized.items.map(item => item.resume_id));
  while (existingIds.has(resumeId)) {
    version += 1;
    resumeId = `${slug(name)}_v${version}`;
  }
  return {
    id: resumeId,
    resume_id: resumeId,
    name,
    version,
    resume_file_path: text(fileReference),
    file_reference: text(fileReference),
    profile_file_path: text(profileFilePath),
    target_roles: list(targetRoles),
    target_role: text(targetRoles?.[0]),
    skills: [],
    experience_summary: '',
    language: text(language),
    content_hash: text(contentHash),
    approved_at: null,
    enabled: true,
    allow_resume_attach: false,
    allow_final_submit: false,
    created_at: now
  };
}

export function normalizeResumeProfiles(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const warnings = [];
  const items = (Array.isArray(source.items) ? source.items : []).map((item, index) => {
    const resumeId = text(item?.resume_id || item?.id) || `resume_${index + 1}`;
    const normalized = {
      ...item,
      id: resumeId,
      resume_id: resumeId,
      name: text(item?.name || resumeId),
      version: Math.max(1, Number.parseInt(item?.version || 1, 10) || 1),
      resume_file_path: text(item?.resume_file_path || item?.file_reference),
      file_reference: text(item?.file_reference || item?.resume_file_path),
      profile_file_path: text(item?.profile_file_path),
      target_roles: list(item?.target_roles || (item?.target_role ? [item.target_role] : [])),
      target_role: text(item?.target_role || item?.target_roles?.[0]),
      skills: list(item?.skills),
      experience_summary: text(item?.experience_summary),
      language: text(item?.language),
      content_hash: text(item?.content_hash),
      approved_at: text(item?.approved_at) || null,
      enabled: item?.enabled !== false,
      allow_resume_attach: false,
      allow_final_submit: false
    };
    if (item?.allow_resume_attach === true) warnings.push(`${resumeId}.allow_resume_attach=true is not allowed by default; forced to false`);
    if (item?.allow_final_submit === true) warnings.push(`${resumeId}.allow_final_submit=true is not allowed; forced to false`);
    if (!normalized.content_hash) warnings.push(`${resumeId}.content_hash is missing; resume content is not verified`);
    if (!normalized.approved_at) warnings.push(`${resumeId}.approved_at is missing; resume is not user approved`);
    return normalized;
  });
  const active = text(source.active_resume_profile_id || source.active_resume_id);
  return {
    value: {
      ...source,
      schema_version: '2.0',
      active_resume_profile_id: items.some(item => item.resume_id === active) ? active : '',
      active_resume_id: items.some(item => item.resume_id === active) ? active : '',
      items
    },
    warnings
  };
}

export function normalizeQuestion(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function questionEquivalenceKey(value) {
  const stopWords = new Set([
    'a', 'an', 'are', 'about', 'can', 'do', 'does', 'for', 'have', 'how', 'in', 'is',
    'of', 'the', 'this', 'to', 'what', 'why', 'would', 'you', 'your'
  ]);
  const tokens = normalizeQuestion(value).split(' ').map(token => token
    .replace(/^authori[sz](?:ed|ation)$/, 'authorize')
    .replace(/^sponsor(?:ed|ship)?$/, 'sponsor')
    .replace(/^relocat(?:e|ion)$/, 'relocate')
    .replace(/^interest(?:ed|ing|s)?$/, 'interest')
    .replace(/^motiv(?:ate|ated|ation)$/, 'motivate'))
    .filter(token => token && !stopWords.has(token))
    .sort();
  return tokens.length >= 2 ? tokens.join(' ') : '';
}

function questionId(normalizedQuestion) {
  return `question_${crypto.createHash('sha256').update(normalizedQuestion).digest('hex').slice(0, 16)}`;
}

// Questions that map onto a profile field the executor already knows how to
// fill. Mirrors the routing the post-fill learning loop uses
// (learning_candidates.mjs canonicalCareerDestination) so an answer typed in
// Settings and the same answer learned from a page land on the same key.
const CANONICAL_ANSWER_KEY_PATTERNS = [
  [/\b(?:full|legal)\s+name\b|姓名|全名/i, 'full_name'],
  [/\bfirst name\b|given name/i, 'first_name'],
  [/\blast name\b|surname|family name/i, 'last_name'],
  [/e-?mail|电子邮箱|邮箱/i, 'email'],
  [/\bphone\b|mobile|telephone|联系电话|手机/i, 'phone'],
  [/linkedin/i, 'linkedin_url'],
  [/github/i, 'github_url'],
  [/portfolio|personal website|website url|作品集|个人网站/i, 'portfolio_url'],
  [/current location|current city|where are you located|所在城市|现居地|当前位置/i, 'location']
];

// Every stored answer needs a stable canonical key, because
// buildApprovedFieldMappings drops any answer without one — that is how
// hand-entered answers used to be silently unusable forever (audit M1 follow-up).
// Known questions map onto their executor field key; everything else gets a
// deterministic key derived from the normalized question, so the same question
// keeps the same key across saves and machines.
export function deriveAnswerCanonicalKey(normalizedQuestion, originalQuestion = '') {
  const haystack = `${originalQuestion} ${normalizedQuestion}`;
  for (const [pattern, key] of CANONICAL_ANSWER_KEY_PATTERNS) {
    if (pattern.test(haystack)) return key;
  }
  // Cross-site question families (shared core, synced into the extension):
  // "How did you hear about us?" and "Where did you learn about this
  // opportunity?" get the SAME canonical key, so one confirmed answer serves
  // every wording on every portal.
  const familyKey = executorCore.questionFamilyKey(originalQuestion)
    || executorCore.questionFamilyKey(normalizedQuestion);
  if (familyKey) return familyKey;
  const seed = text(normalizedQuestion) || text(originalQuestion);
  if (!seed) return '';
  return `answer_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

export function normalizeAnswerRecord(input = {}, { now = new Date().toISOString() } = {}) {
  const originalQuestion = text(input.original_question || input.question || input.question_patterns?.[0] || input.canonical_key || input.id);
  const normalizedQuestion = normalizeQuestion(input.normalized_question || originalQuestion);
  const scope = text(input.scope) || 'global';
  const scopeKey = text(input.scope_key);
  const stableQuestionId = questionId(scope === 'global' && !scopeKey
    ? normalizedQuestion
    : `${normalizedQuestion}\u001f${scope}\u001f${scopeKey.toLocaleLowerCase('en-US')}`);
  const source = ANSWER_SOURCES.has(input.source)
    ? input.source
    : input.approved_by_user || input.approved_for_real_applications ? 'historical_confirmed' : 'model_suggested';
  const userConfirmed = input.user_confirmed === true || input.approved_by_user === true || input.approved_for_real_applications === true;
  const riskLevel = text(input.risk_level).toLocaleLowerCase('en-US') || 'normal';
  const sensitiveCategory = text(input.sensitive_category || (riskLevel === 'high' ? input.category || 'sensitive' : 'none'));
  const reusePolicy = ['auto', 'ask', 'never'].includes(text(input.reuse_policy)) ? text(input.reuse_policy) : 'auto';
  return {
    ...input,
    id: text(input.id) || stableQuestionId,
    question_id: text(input.question_id || input.id) || stableQuestionId,
    normalized_question: normalizedQuestion,
    original_question: originalQuestion,
    // Self-healing like approved_for_real_applications: an answer stored before
    // this key existed gets one on first read, and a legacy hash key upgrades
    // to its question-family/profile key when the derivation now knows one —
    // so existing answer banks start cross-site reuse without a migration.
    canonical_key: (() => {
      const stored = text(input.canonical_key);
      const derived = deriveAnswerCanonicalKey(normalizedQuestion, originalQuestion);
      if (!stored) return derived;
      if (/^answer_[0-9a-f]{12}$/.test(stored) && derived && !derived.startsWith('answer_')) return derived;
      return stored;
    })(),
    answer: text(input.answer),
    source,
    scope,
    scope_key: scopeKey,
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : (userConfirmed ? 1 : 0),
    risk_level: riskLevel,
    sensitive_category: sensitiveCategory,
    user_confirmed: userConfirmed,
    // Knowledge-base metadata: the wordings this answer has been seen under,
    // the sites they came from, and how the user wants it reused.
    // reuse_policy: 'auto' (fill silently when matched) | 'ask' (suggest, the
    // user confirms per application) | 'never' (stored but not reused).
    question_variants: [...new Set([
      ...(Array.isArray(input.question_variants) ? input.question_variants : []).map(text),
      originalQuestion
    ].filter(Boolean))].slice(0, 25),
    source_sites: [...new Set((Array.isArray(input.source_sites) ? input.source_sites : [])
      .concat(text(input.source_site) ? [text(input.source_site)] : [])
      .map(site => text(site).toLocaleLowerCase('en-US'))
      .filter(Boolean))].slice(0, 25),
    reuse_policy: reusePolicy,
    version: Math.max(1, Number.parseInt(input.version || 1, 10) || 1),
    last_confirmed_at: userConfirmed ? (text(input.last_confirmed_at || input.updated_at) || now) : null,
    last_used: text(input.last_used) || null,
    superseded_answers: Array.isArray(input.superseded_answers) ? input.superseded_answers : [],
    status: userConfirmed ? 'approved' : (text(input.status) || 'draft'),
    approved_by_user: userConfirmed,
    // Reuse approval is always derived, never trusted from input: a stored
    // answer may auto-fill real applications only when the user confirmed it,
    // it is neither sensitive nor high-risk (audit M1 / acceptance #13), AND
    // its reuse policy allows silent reuse.
    approved_for_real_applications: userConfirmed
      && sensitiveCategory.toLocaleLowerCase('en-US') === 'none'
      && riskLevel !== 'high'
      && reusePolicy === 'auto'
  };
}

export function normalizeAnswerMemory(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    ...source,
    version: '2.0',
    answers: (Array.isArray(source.answers) ? source.answers : []).map(answer => normalizeAnswerRecord(answer))
  };
}

// Metadata that must survive a partial re-save (the Settings form and PUT
// patches omit these): without inheritance an update would strip the
// canonical_key/risk classification the learning loop attached earlier.
const STICKY_ANSWER_KEYS = [
  'canonical_key', 'risk_level', 'sensitive_category', 'category',
  'question_patterns', 'keywords', 'provenance', 'answer_type', 'profile_key',
  'source_job', 'source_application', 'source_url', 'source_portal', 'last_used'
];

function providedValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function upsertAnswerMemoryWithResult(memory, input, { now = new Date().toISOString() } = {}) {
  const normalizedMemory = normalizeAnswerMemory(memory);
  if (input?.source && !ANSWER_SOURCES.has(input.source)) throw new Error(`unsupported answer source: ${input.source}`);
  const incoming = normalizeAnswerRecord(input, { now });
  if (!incoming.normalized_question) throw new Error('original_question is required');
  if (!incoming.answer) throw new Error('answer is required');
  const sameScope = answer => answer.scope === incoming.scope
    && text(answer.scope_key).toLocaleLowerCase('en-US') === text(incoming.scope_key).toLocaleLowerCase('en-US');
  // One knowledge item per question identity: exact id, same normalized text,
  // or the same NON-HASH canonical key (question family / profile field) —
  // a differently-worded save merges into the existing item as a variant
  // instead of spawning a duplicate record.
  const canonicalMergeable = incoming.canonical_key && !incoming.canonical_key.startsWith('answer_');
  const index = normalizedMemory.answers.findIndex(answer =>
    answer.question_id === incoming.question_id
    || (answer.normalized_question === incoming.normalized_question && sameScope(answer))
    || (canonicalMergeable && answer.canonical_key === incoming.canonical_key && sameScope(answer))
  );
  if (index < 0) {
    return {
      memory: {
        ...normalizedMemory,
        updated_at: now,
        answers: [...normalizedMemory.answers, incoming]
      },
      record: incoming
    };
  }
  const previous = normalizedMemory.answers[index];
  const history = [
    ...(previous.superseded_answers || []),
    {
      version: previous.version,
      answer: previous.answer,
      source: previous.source,
      user_confirmed: previous.user_confirmed,
      last_confirmed_at: previous.last_confirmed_at,
      superseded_at: now
    }
  ];
  const inherited = {};
  for (const key of STICKY_ANSWER_KEYS) {
    if (!providedValue(input?.[key]) && providedValue(previous[key])) inherited[key] = previous[key];
  }
  const replacement = normalizeAnswerRecord({
    ...input,
    ...inherited,
    // Wordings and source sites accumulate across saves — merging a new
    // wording must never lose the ones already learned.
    question_variants: [
      ...(previous.question_variants || []),
      ...(Array.isArray(input?.question_variants) ? input.question_variants : []),
      previous.original_question,
      incoming.original_question
    ].filter(Boolean),
    source_sites: [
      ...(previous.source_sites || []),
      ...(Array.isArray(input?.source_sites) ? input.source_sites : []),
      ...(providedValue(input?.source_site) ? [input.source_site] : [])
    ].filter(Boolean),
    id: previous.id,
    question_id: previous.question_id,
    version: previous.version + 1,
    superseded_answers: history
  }, { now });
  const answers = [...normalizedMemory.answers];
  answers[index] = replacement;
  return { memory: { ...normalizedMemory, updated_at: now, answers }, record: replacement };
}

export function upsertAnswerMemory(memory, input, options) {
  return upsertAnswerMemoryWithResult(memory, input, options).memory;
}

export function resolveConfirmedAnswer(memory, question, context = {}) {
  const normalized = normalizeQuestion(question);
  const equivalent = questionEquivalenceKey(question);
  const matchesScope = (answer) => {
    if (!answer.scope || answer.scope === 'global') return true;
    const expected = text(answer.scope_key).toLocaleLowerCase('en-US');
    if (!expected) return false;
    if (answer.scope === 'employer') return text(context.employer || context.company).toLocaleLowerCase('en-US') === expected;
    if (answer.scope === 'role') return text(context.role || context.title).toLocaleLowerCase('en-US') === expected;
    if (answer.scope === 'country') return text(context.country).toLocaleLowerCase('en-US') === expected;
    if (answer.scope === 'portal') return text(context.portal).toLocaleLowerCase('en-US') === expected;
    return false;
  };
  return normalizeAnswerMemory(memory).answers
    .filter(answer => answer.user_confirmed && answer.answer && matchesScope(answer))
    .map(answer => ({
      answer,
      match: answer.normalized_question === normalized
        ? 2
        : equivalent && questionEquivalenceKey(answer.original_question || answer.normalized_question) === equivalent ? 1 : 0
    }))
    .filter(item => item.match > 0)
    .sort((a, b) => b.match - a.match
      || (a.answer.scope === 'global' ? 1 : 0) - (b.answer.scope === 'global' ? 1 : 0)
      || b.answer.version - a.answer.version)
    .map(item => ({
      ...item.answer,
      matched_equivalent_wording: item.match === 1,
      reuse_requires_confirmation: item.answer.risk_level === 'high' || item.answer.sensitive_category !== 'none'
    }))[0] || null;
}
