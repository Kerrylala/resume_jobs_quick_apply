import crypto from 'node:crypto';

export const LEARNING_CANDIDATE_SCHEMA_VERSION = '1.0';

const PROHIBITED_FIELD_RE = /(?:password|passcode|one[ -]?time|\botp\b|captcha|verification|security code|social security|\bssn\b|national id|passport|bank|routing|credit card|debit card|financial|race|ethnicity|gender|sex assigned|disability|veteran|medical|health|date of birth|birth date|authentication|token|cookie|file upload|resume|curriculum vitae|cover letter)/i;
const HIGH_RISK_FIELD_RE = /(?:work authori[sz]ation|authori[sz]ed to work|sponsor(?:ship)?|salary|compensation|criminal|legal declaration|relocat(?:e|ion)|notice period|right to work|visa)/i;
const PROHIBITED_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image']);

function text(value, max = 5000) {
  return String(value ?? '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().slice(0, max);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hash(value, length = 20) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function fieldText(field = {}) {
  // group_label and option_label are included so the prohibited/high-risk
  // screens see the real QUESTION text of ARIA option widgets — an EEO answer
  // must be recognized by its question, not slip past as a bare option word.
  return [field.label, field.group_label, field.option_label, field.name, field.id, field.placeholder, field.autocomplete]
    .map(value => text(value, 500)).filter(Boolean).join(' ');
}

export function learningFieldSignature(field = {}) {
  const existing = text(field.field_signature, 1000);
  if (existing) return existing;
  // option_label keeps sibling options of one ARIA group distinct — they share
  // tag/type/label(question) and usually have no name or id.
  return [field.tag, field.type, field.name, field.id, field.label, field.option_label]
    .map(value => text(value, 500).toLocaleLowerCase('en-US'))
    .join(' | ');
}

function canonicalCareerDestination(field = {}) {
  const haystack = fieldText(field);
  const patterns = [
    [/\b(?:full|legal) name\b|\bname\b|姓名|全名/i, ['identity.full_name', 'full_name']],
    [/\bfirst name\b|given name|名/i, ['identity.first_name', 'first_name']],
    [/\blast name\b|surname|family name|姓/i, ['identity.last_name', 'last_name']],
    [/e-?mail|电子邮箱|邮箱/i, ['identity.email', 'email']],
    [/\bphone\b|mobile|telephone|联系电话|手机/i, ['identity.phone', 'phone']],
    [/linkedin/i, ['identity.links.linkedin', 'linkedin_url']],
    [/github/i, ['identity.links.github', 'github_url']],
    [/portfolio|personal website|website url|作品集|个人网站/i, ['identity.links.portfolio', 'portfolio_url']],
    [/current location|current city|where are you located|city.*residen|所在城市|现居地|当前位置/i, ['identity.current_location', 'location']],
    [/\bcountry\b|国家/i, ['identity.country', 'location']]
  ];
  for (const [pattern, destination] of patterns) {
    if (pattern.test(haystack)) return { canonical_path: destination[0], executor_key: destination[1] };
  }
  return null;
}

function snapshotField(input = {}) {
  const source = object(input);
  const type = text(source.type, 100).toLowerCase();
  const value = text(source.value, 5000);
  return {
    field_ref: text(source.field_ref, 200),
    field_signature: learningFieldSignature(source),
    tag: text(source.tag, 50).toLowerCase(),
    type,
    name: text(source.name, 500),
    id: text(source.id, 500),
    label: text(source.label || source.group_label || source.placeholder || source.name || source.id, 1000),
    option_label: text(source.option_label, 300),
    group_label: text(source.group_label, 300),
    placeholder: text(source.placeholder, 1000),
    autocomplete: text(source.autocomplete, 200),
    visible: source.visible !== false,
    disabled: source.disabled === true,
    read_only: source.read_only === true,
    value
  };
}

function portalFromUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    if (host === 'jobs.lever.co' || host.endsWith('.lever.co')) return 'lever';
    if (host === 'boards.greenhouse.io' || host.endsWith('.greenhouse.io')) return 'greenhouse';
    if (host.endsWith('.myworkdayjobs.com') || host.endsWith('.workdayjobs.com')) return 'workday';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function hostFromUrl(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase(); } catch { return ''; }
}

export function buildLearningCandidates({
  session = {},
  baselineSnapshot = [],
  currentSnapshot = [],
  now = new Date().toISOString()
} = {}) {
  const baseline = new Map((Array.isArray(baselineSnapshot) ? baselineSnapshot : [])
    .map(snapshotField).map(field => [field.field_signature || field.field_ref, field]));
  const output = [];
  for (const rawField of Array.isArray(currentSnapshot) ? currentSnapshot : []) {
    const field = snapshotField(rawField);
    if (!field.visible || field.disabled || field.read_only || PROHIBITED_TYPES.has(field.type)) continue;
    const descriptor = fieldText(field);
    if (!field.value || PROHIBITED_FIELD_RE.test(descriptor)) continue;
    const previous = baseline.get(field.field_signature || field.field_ref);
    if (previous && previous.value === field.value) continue;
    const career = canonicalCareerDestination(field);
    const highRisk = HIGH_RISK_FIELD_RE.test(descriptor);
    const destination = career ? 'career_brain' : 'answer_memory';
    const normalizedQuestion = text(field.label || field.name || field.id, 1000)
      .toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const candidateId = `learning_${hash([
      session.session_id, field.field_signature, hash(field.value, 32)
    ].join('\u001f'))}`;
    output.push({
      candidate_id: candidateId,
      session_id: text(session.session_id, 200),
      application_id: text(session.application_id, 200),
      job_id: text(session.job_id, 200),
      package_id: text(session.package_id, 300),
      source_url: text(session.target_url || session.url, 2000),
      portal: portalFromUrl(session.target_url || session.url),
      domain: hostFromUrl(session.target_url || session.url),
      field_signature: field.field_signature,
      field_ref: field.field_ref,
      label: field.label || 'Application question',
      original_question: field.label || field.name || field.id || 'Application question',
      normalized_question: normalizedQuestion,
      answer_type: field.type || field.tag || 'text',
      value: field.value,
      suggested_destination: destination,
      canonical_path: career?.canonical_path || '',
      executor_key: career?.executor_key || `answer_${hash(normalizedQuestion || field.field_signature, 16)}`,
      suggested_scope: career ? 'global' : (highRisk ? 'do_not_save' : 'employer'),
      scope_options: ['global', 'employer', 'role', 'do_not_save'],
      risk_level: highRisk ? 'high' : (career && ['identity.email', 'identity.phone'].includes(career.canonical_path) ? 'medium' : 'normal'),
      status: 'pending',
      user_confirmed: false,
      created_at: now,
      updated_at: now,
      provenance: {
        source: 'post_fill_review_rescan',
        source_job: text(session.job_id, 200),
        source_application: text(session.application_id, 200),
        source_session: text(session.session_id, 200)
      }
    });
  }
  return output;
}

export function normalizeLearningCandidateStore(input = {}) {
  const source = object(input);
  return {
    schema_version: LEARNING_CANDIDATE_SCHEMA_VERSION,
    updated_at: text(source.updated_at, 100) || null,
    session_drafts: object(source.session_drafts),
    candidates: (Array.isArray(source.candidates) ? source.candidates : [])
      .filter(candidate => candidate && typeof candidate === 'object' && candidate.candidate_id)
      .map(candidate => ({ ...structuredClone(candidate), value: text(candidate.value, 5000) }))
      .slice(-2000)
  };
}

export function recordLearningCandidates(store, candidates = [], { now = new Date().toISOString() } = {}) {
  const normalized = normalizeLearningCandidateStore(store);
  const byId = new Map(normalized.candidates.map(candidate => [candidate.candidate_id, candidate]));
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate?.candidate_id) continue;
    const previous = byId.get(candidate.candidate_id);
    byId.set(candidate.candidate_id, previous?.status && previous.status !== 'pending'
      ? previous
      : { ...structuredClone(candidate), status: 'pending', user_confirmed: false, updated_at: now });
  }
  return { ...normalized, updated_at: now, candidates: [...byId.values()].slice(-2000) };
}

export function decideLearningCandidate(store, {
  candidateId,
  decision,
  editedValue,
  destination,
  scope,
  now = new Date().toISOString()
} = {}) {
  const normalized = normalizeLearningCandidateStore(store);
  const index = normalized.candidates.findIndex(candidate => candidate.candidate_id === text(candidateId, 200));
  if (index < 0) {
    const error = new Error('Learning candidate was not found.');
    error.code = 'LEARNING_CANDIDATE_NOT_FOUND';
    throw error;
  }
  const current = normalized.candidates[index];
  if (current.status !== 'pending') return { store: normalized, candidate: current, idempotent_replay: true };
  const safeDecision = decision === 'save' ? 'save' : 'reject';
  const selectedScope = ['global', 'employer', 'role', 'do_not_save'].includes(scope) ? scope : current.suggested_scope;
  if (safeDecision === 'save' && selectedScope === 'do_not_save') {
    const error = new Error('Choose Save globally, employer only, or role only before saving.');
    error.code = 'LEARNING_SCOPE_REQUIRED';
    throw error;
  }
  const value = text(editedValue === undefined ? current.value : editedValue, 5000);
  if (safeDecision === 'save' && !value) {
    const error = new Error('A confirmed value is required.');
    error.code = 'LEARNING_VALUE_REQUIRED';
    throw error;
  }
  const selectedDestination = ['career_brain', 'answer_memory'].includes(destination)
    ? destination
    : current.suggested_destination;
  const candidate = {
    ...current,
    value: safeDecision === 'save' ? value : '',
    selected_destination: selectedDestination,
    selected_scope: selectedScope,
    status: safeDecision === 'save' ? 'confirmed' : 'rejected',
    user_confirmed: safeDecision === 'save',
    confirmed_at: safeDecision === 'save' ? now : null,
    rejected_at: safeDecision === 'reject' ? now : null,
    updated_at: now
  };
  const candidates = [...normalized.candidates];
  candidates[index] = candidate;
  return { store: { ...normalized, updated_at: now, candidates }, candidate, idempotent_replay: false };
}

export function finalizeLearningCandidate(store, candidateId, result = {}, { now = new Date().toISOString() } = {}) {
  const normalized = normalizeLearningCandidateStore(store);
  const candidates = normalized.candidates.map(candidate => candidate.candidate_id === text(candidateId, 200)
    ? {
        ...candidate,
        value: '',
        status: candidate.user_confirmed ? 'saved' : candidate.status,
        value_retained_in_candidate_store: false,
        save_result: structuredClone(result),
        updated_at: now
      }
    : candidate);
  return { ...normalized, updated_at: now, candidates };
}

export function learningCandidatesFor(store, { sessionId = '', jobId = '', status = 'pending' } = {}) {
  return normalizeLearningCandidateStore(store).candidates.filter(candidate =>
    (!sessionId || candidate.session_id === sessionId)
    && (!jobId || candidate.job_id === jobId)
    && (!status || candidate.status === status)
  );
}

export function normalizeFormFieldMemory(input = {}) {
  const source = object(input);
  return {
    schema_version: '1.0',
    updated_at: text(source.updated_at, 100) || null,
    records: (Array.isArray(source.records) ? source.records : []).map(record => {
      const safe = {
        record_id: text(record.record_id, 200),
        portal: text(record.portal, 100),
        domain: text(record.domain, 500),
        field_signature: text(record.field_signature, 1000),
        destination_type: text(record.destination_type, 100),
        canonical_key: text(record.canonical_key, 300),
        question_id: text(record.question_id, 300),
        source: text(record.source, 200) || 'confirmed_learning_candidate',
        confidence: Math.max(0, Math.min(1, Number(record.confidence || 0))),
        user_confirmed: record.user_confirmed === true,
        status: text(record.status, 100) || 'observed',
        first_seen: text(record.first_seen, 100) || null,
        last_seen: text(record.last_seen, 100) || null,
        last_used: text(record.last_used, 100) || null,
        use_count: Math.max(0, Number(record.use_count || 0))
      };
      return safe;
    }).filter(record => record.record_id && record.field_signature && record.canonical_key)
  };
}

export function confirmFormFieldMapping(memory, candidate, { now = new Date().toISOString() } = {}) {
  const normalized = normalizeFormFieldMemory(memory);
  const canonicalKey = text(candidate.executor_key || candidate.canonical_path, 300);
  const recordId = `field_memory_${hash([candidate.portal, candidate.domain, candidate.field_signature, canonicalKey].join('|'))}`;
  const incoming = {
    record_id: recordId,
    portal: text(candidate.portal, 100),
    domain: text(candidate.domain, 500),
    field_signature: text(candidate.field_signature, 1000),
    destination_type: candidate.selected_destination || candidate.suggested_destination,
    canonical_key: canonicalKey,
    question_id: candidate.selected_destination === 'answer_memory' ? text(candidate.answer_memory_question_id, 300) : '',
    source: 'confirmed_learning_candidate',
    confidence: 0.95,
    user_confirmed: true,
    status: 'active',
    first_seen: now,
    last_seen: now,
    last_used: null,
    use_count: 0
  };
  const index = normalized.records.findIndex(record => record.record_id === recordId);
  const records = [...normalized.records];
  if (index < 0) records.push(incoming);
  else records[index] = { ...records[index], ...incoming, first_seen: records[index].first_seen || now };
  return { ...normalized, updated_at: now, records };
}

export function formFieldMemoryRules(memory, targetUrl = '') {
  const normalized = normalizeFormFieldMemory(memory);
  const domain = hostFromUrl(targetUrl);
  const portal = portalFromUrl(targetUrl);
  return normalized.records.filter(record =>
    record.status === 'active' && record.user_confirmed
    && (record.domain === domain || (record.portal !== 'unknown' && record.portal === portal))
  ).map(record => {
    const parts = record.field_signature.split('|').map(item => text(item, 500)).filter(Boolean);
    return {
      key: record.canonical_key,
      aliases: parts.slice(2).filter(Boolean),
      confidence: record.confidence,
      source: 'confirmed_form_field_memory'
    };
  });
}
