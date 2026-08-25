import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUploadedResumeProfile,
  matchesResumeContentHash,
  normalizeAnswerMemory,
  normalizeResumeProfiles,
  resolveConfirmedAnswer,
  selectBestResumeProfile,
  validateResumeUpload,
  upsertAnswerMemory
} from '../scripts/lib/candidate_records.mjs';

function syntheticStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name);
    const content = Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

test('legacy resume metadata gains stable version fields without reading the file', () => {
  const { value, warnings } = normalizeResumeProfiles({
    active_resume_profile_id: 'resume_pm',
    items: [{
      id: 'resume_pm',
      resume_file_path: 'synthetic/resume.pdf',
      target_roles: ['Product Manager'],
      language: 'en'
    }]
  });
  assert.equal(value.active_resume_id, 'resume_pm');
  assert.equal(value.items[0].resume_id, 'resume_pm');
  assert.equal(value.items[0].version, 1);
  assert.equal(value.items[0].file_reference, 'synthetic/resume.pdf');
  assert.equal(value.items[0].content_hash, '');
  assert.equal(value.items[0].approved_at, null);
  assert.equal(warnings.length, 2);
});

test('synthetic PDF intake verifies type, size and content hash without parsing facts', () => {
  const content = Buffer.from('%PDF-1.4\nSynthetic resume fixture\n%%EOF\n');
  const upload = validateResumeUpload({
    file_name: 'Synthetic Resume.PDF',
    content_base64: content.toString('base64')
  });
  assert.equal(upload.file_name, 'Synthetic Resume.PDF');
  assert.equal(upload.extension, '.pdf');
  assert.equal(upload.size_bytes, content.length);
  assert.match(upload.content_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(upload, 'facts'), false);
  assert.equal(matchesResumeContentHash(content, upload.content_hash), true);
  assert.equal(matchesResumeContentHash(Buffer.from('%PDF-1.4\nChanged\n'), upload.content_hash), false);
});

test('synthetic DOCX intake verifies the ZIP directory and required document entries', () => {
  const content = syntheticStoredZip([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', '<document><p>Synthetic</p></document>']
  ]);
  const upload = validateResumeUpload({
    file_name: 'Synthetic Resume.docx',
    content_base64: content.toString('base64')
  });
  assert.equal(upload.extension, '.docx');
  assert.equal(upload.size_bytes, content.length);
  assert.match(upload.content_hash, /^sha256:[a-f0-9]{64}$/);
});

test('synthetic TXT intake requires readable UTF-8 plain text', () => {
  const content = Buffer.from('Synthetic Candidate\ncandidate@local.invalid\nSkills: analytics, roadmapping\n', 'utf8');
  const upload = validateResumeUpload({
    file_name: 'Synthetic Resume.txt',
    content_base64: content.toString('base64')
  });
  assert.equal(upload.extension, '.txt');
  assert.equal(upload.size_bytes, content.length);
  assert.match(upload.content_hash, /^sha256:[a-f0-9]{64}$/);
  assert.throws(
    () => validateResumeUpload({
      file_name: 'binary.txt',
      content_base64: Buffer.from([0, 1, 2, 3, 255]).toString('base64')
    }),
    error => ['INVALID_RESUME_TEXT_ENCODING', 'INVALID_RESUME_TEXT_CONTENT'].includes(error.code)
  );
});

test('resume upload rejects extension spoofing and unsafe formats', () => {
  assert.throws(
    () => validateResumeUpload({
      file_name: 'resume.pdf',
      content_base64: Buffer.from('not a pdf').toString('base64')
    }),
    error => error.code === 'RESUME_SIGNATURE_MISMATCH'
  );
  assert.throws(
    () => validateResumeUpload({
      file_name: 'resume.exe',
      content_base64: Buffer.from('MZ').toString('base64')
    }),
    error => error.code === 'UNSUPPORTED_RESUME_TYPE'
  );
});

test('uploaded resumes reuse the existing versioned profile schema and remain unapproved', () => {
  const first = buildUploadedResumeProfile({ items: [] }, {
    fileName: 'General.pdf',
    displayName: 'General SWE',
    fileReference: 'documents/resumes/general_swe_v1.pdf',
    contentHash: 'sha256:first',
    targetRoles: ['Software Engineer'],
    language: 'en',
    now: '2026-07-23T00:00:00.000Z'
  });
  const second = buildUploadedResumeProfile({ items: [first] }, {
    fileName: 'General.docx',
    displayName: 'General SWE',
    fileReference: 'documents/resumes/general_swe_v2.docx',
    contentHash: 'sha256:second',
    targetRoles: ['Software Engineer'],
    language: 'en',
    now: '2026-07-24T00:00:00.000Z'
  });
  assert.equal(first.resume_id, 'general_swe_v1');
  assert.equal(second.resume_id, 'general_swe_v2');
  assert.equal(second.version, 2);
  assert.equal(second.approved_at, null);
  assert.equal(second.allow_resume_attach, false);
  assert.equal(second.allow_final_submit, false);
});

test('best resume selection ranks approved role and skill matches above the active fallback', () => {
  const selection = selectBestResumeProfile({
    active_resume_profile_id: 'general_v1',
    items: [{
      resume_id: 'general_v1',
      name: 'General Resume',
      version: 1,
      file_reference: 'synthetic/general.pdf',
      content_hash: 'sha256:general',
      approved_at: '2026-07-23T00:00:00.000Z',
      target_roles: ['Operations'],
      skills: ['spreadsheets']
    }, {
      resume_id: 'product_v2',
      name: 'Product Resume',
      version: 2,
      file_reference: 'synthetic/product.pdf',
      content_hash: 'sha256:product',
      approved_at: '2026-07-23T00:00:00.000Z',
      target_roles: ['Product Manager'],
      skills: ['roadmapping', 'analytics']
    }]
  }, {
    title: 'Product Manager',
    description_text: 'Own product roadmapping and analytics.'
  });

  assert.equal(selection.selected_resume.resume_id, 'product_v2');
  assert.equal(selection.recommended_resume.resume_id, 'product_v2');
  assert.equal(selection.selection.mode, 'recommended');
  assert.equal(selection.selection.confidence, 0.95);
  assert.ok(selection.selection.candidates.find(item => item.resume_id === 'product_v2').score > 60);
});

test('best resume selection supports an eligible user override without changing the recommendation', () => {
  const profiles = {
    active_resume_profile_id: 'general_v1',
    items: [{
      resume_id: 'general_v1',
      name: 'General Resume',
      file_reference: 'synthetic/general.pdf',
      content_hash: 'sha256:general',
      approved_at: '2026-07-23T00:00:00.000Z',
      target_roles: ['Operations']
    }, {
      resume_id: 'product_v1',
      name: 'Product Resume',
      file_reference: 'synthetic/product.pdf',
      content_hash: 'sha256:product',
      approved_at: '2026-07-23T00:00:00.000Z',
      target_roles: ['Product Manager']
    }]
  };
  const selection = selectBestResumeProfile(profiles, { title: 'Product Manager' }, {
    preferredResumeId: 'general_v1'
  });

  assert.equal(selection.selected_resume.resume_id, 'general_v1');
  assert.equal(selection.recommended_resume.resume_id, 'product_v1');
  assert.equal(selection.selection.mode, 'user_override');
});

test('best resume selection excludes unapproved versions and rejects an unsafe override', () => {
  const selection = selectBestResumeProfile({
    active_resume_profile_id: 'pending_v1',
    items: [{
      resume_id: 'pending_v1',
      name: 'Pending Product Resume',
      file_reference: 'synthetic/pending.pdf',
      content_hash: 'sha256:pending',
      approved_at: null,
      target_roles: ['Product Manager']
    }, {
      resume_id: 'approved_v1',
      name: 'Approved General Resume',
      file_reference: 'synthetic/approved.pdf',
      content_hash: 'sha256:approved',
      approved_at: '2026-07-23T00:00:00.000Z',
      target_roles: ['Operations']
    }]
  }, { title: 'Product Manager' }, { preferredResumeId: 'pending_v1' });

  assert.equal(selection.selected_resume, null);
  assert.equal(selection.recommended_resume.resume_id, 'approved_v1');
  assert.equal(selection.selection.mode, 'invalid_user_override');
  assert.deepEqual(
    selection.selection.candidates.find(item => item.resume_id === 'pending_v1').ineligible_reasons,
    ['not_user_approved']
  );
});

test('confirmed answers are versioned and old answers are retained', () => {
  const first = upsertAnswerMemory({ answers: [] }, {
    original_question: 'Are you authorized to work?',
    answer: 'User-confirmed answer v1',
    source: 'user_entered',
    user_confirmed: true,
    sensitive_category: 'work_authorization'
  }, { now: '2026-01-01T00:00:00.000Z' });
  const second = upsertAnswerMemory(first, {
    original_question: 'Are you authorized to work',
    answer: 'User-confirmed answer v2',
    source: 'user_confirmed',
    user_confirmed: true,
    sensitive_category: 'work_authorization'
  }, { now: '2026-02-01T00:00:00.000Z' });
  assert.equal(second.answers.length, 1);
  assert.equal(second.answers[0].version, 2);
  assert.equal(second.answers[0].superseded_answers.length, 1);
  assert.equal(resolveConfirmedAnswer(second, 'Are you authorized to work?').answer, 'User-confirmed answer v2');
});

test('model suggestions are never promoted to confirmed answers implicitly', () => {
  const memory = normalizeAnswerMemory({
    answers: [{
      question: 'Why this role?',
      answer: 'Synthetic suggestion',
      source: 'model_suggested'
    }]
  });
  assert.equal(memory.answers[0].user_confirmed, false);
  assert.equal(resolveConfirmedAnswer(memory, 'Why this role?'), null);
});

test('confirmed Answer Memory matches equivalent wording within its saved scope', () => {
  const memory = upsertAnswerMemory({}, {
    original_question: 'Are you authorized to work?',
    answer: 'Synthetic confirmed answer',
    source: 'user_confirmed',
    user_confirmed: true,
    scope: 'employer',
    scope_key: 'Example Employer',
    risk_level: 'high'
  }, { now: '2026-08-11T00:00:00.000Z' });
  assert.equal(resolveConfirmedAnswer(memory, 'Do you have authorization to work?', {
    employer: 'Other Employer'
  }), null);
  const matched = resolveConfirmedAnswer(memory, 'Do you have authorization to work?', {
    employer: 'Example Employer'
  });
  assert.equal(matched.answer, 'Synthetic confirmed answer');
  assert.equal(matched.matched_equivalent_wording, true);
  assert.equal(matched.reuse_requires_confirmation, true);
});

test('confirmed Answer Memory recognizes a conservative interest-question paraphrase', () => {
  const memory = upsertAnswerMemory({}, {
    original_question: 'What interests you about this role?',
    answer: 'Synthetic confirmed answer',
    source: 'user_confirmed',
    user_confirmed: true,
    scope: 'global',
    risk_level: 'normal'
  }, { now: '2026-08-11T00:00:00.000Z' });
  const matched = resolveConfirmedAnswer(memory, 'Why are you interested in this role?');
  assert.equal(matched.answer, 'Synthetic confirmed answer');
  assert.equal(matched.matched_equivalent_wording, true);
  assert.equal(matched.reuse_requires_confirmation, false);
});

test('reuse approval is derived: confirmed safe answers approve, sensitive and high-risk never do', () => {
  const safe = upsertAnswerMemory({ answers: [] }, {
    original_question: 'What is your notice period?',
    answer: 'Synthetic thirty days',
    source: 'user_entered',
    user_confirmed: true,
    sensitive_category: 'none',
    risk_level: 'normal'
  }, { now: '2026-08-15T00:00:00.000Z' }).answers[0];
  assert.equal(safe.approved_for_real_applications, true);

  const unconfirmed = upsertAnswerMemory({ answers: [] }, {
    original_question: 'What is your notice period?',
    answer: 'Synthetic suggestion',
    source: 'model_suggested'
  }).answers[0];
  assert.equal(unconfirmed.approved_for_real_applications, false);

  const sensitive = upsertAnswerMemory({ answers: [] }, {
    original_question: 'Do you require sponsorship?',
    answer: 'Synthetic sensitive answer',
    source: 'user_confirmed',
    user_confirmed: true,
    sensitive_category: 'work_authorization'
  }).answers[0];
  assert.equal(sensitive.approved_for_real_applications, false);
  assert.equal(sensitive.status, 'approved');

  const highRisk = upsertAnswerMemory({ answers: [] }, {
    original_question: 'Have you ever been convicted?',
    answer: 'Synthetic declaration',
    source: 'user_confirmed',
    user_confirmed: true,
    sensitive_category: 'none',
    risk_level: 'high'
  }).answers[0];
  assert.equal(highRisk.approved_for_real_applications, false);
  assert.equal(highRisk.sensitive_category, 'none');
});

test('a stored approved flag is re-derived, never trusted from input', () => {
  const memory = normalizeAnswerMemory({
    answers: [{
      original_question: 'Have you ever been convicted?',
      answer: 'Synthetic declaration',
      source: 'user_confirmed',
      user_confirmed: true,
      risk_level: 'high',
      approved_for_real_applications: true
    }]
  });
  assert.equal(memory.answers[0].approved_for_real_applications, false);
  assert.equal(memory.answers[0].user_confirmed, true);
});

test('re-saving an answer without metadata keeps sticky fields from the previous record', () => {
  const first = upsertAnswerMemory({ answers: [] }, {
    original_question: 'Do you require visa sponsorship?',
    answer: 'Synthetic answer v1',
    source: 'user_confirmed',
    user_confirmed: true,
    canonical_key: 'sponsorship',
    risk_level: 'high',
    sensitive_category: 'work_authorization',
    provenance: { source: 'post_fill_review_rescan' }
  }, { now: '2026-08-01T00:00:00.000Z' });
  const second = upsertAnswerMemory(first, {
    original_question: 'Do you require visa sponsorship?',
    answer: 'Synthetic answer v2',
    source: 'user_entered',
    user_confirmed: true
  }, { now: '2026-08-15T00:00:00.000Z' });
  const record = second.answers[0];
  assert.equal(record.version, 2);
  assert.equal(record.answer, 'Synthetic answer v2');
  assert.equal(record.canonical_key, 'sponsorship');
  assert.equal(record.risk_level, 'high');
  assert.equal(record.sensitive_category, 'work_authorization');
  assert.deepEqual(record.provenance, { source: 'post_fill_review_rescan' });
  assert.equal(record.approved_for_real_applications, false);
});

test('upsertAnswerMemoryWithResult returns the exact stored record for scoped answers', async () => {
  const { upsertAnswerMemoryWithResult } = await import('../scripts/lib/candidate_records.mjs');
  let state = { answers: [] };
  ({ memory: state } = upsertAnswerMemoryWithResult(state, {
    original_question: 'Why this company?',
    answer: 'Synthetic global answer',
    source: 'user_confirmed',
    user_confirmed: true
  }, { now: '2026-08-01T00:00:00.000Z' }));
  const { memory: next, record } = upsertAnswerMemoryWithResult(state, {
    original_question: 'Why this company?',
    answer: 'Synthetic employer answer',
    source: 'user_confirmed',
    user_confirmed: true,
    scope: 'employer',
    scope_key: 'Example Employer'
  }, { now: '2026-08-15T00:00:00.000Z' });
  assert.equal(next.answers.length, 2);
  assert.equal(record.answer, 'Synthetic employer answer');
  assert.equal(record.scope, 'employer');
  assert.equal(record.version, 1);
});

test('unsupported provenance is rejected explicitly', () => {
  assert.throws(
    () => upsertAnswerMemory({ answers: [] }, {
      question: 'Synthetic question',
      answer: 'Synthetic answer',
      source: 'invented'
    }),
    /unsupported answer source/
  );
});
