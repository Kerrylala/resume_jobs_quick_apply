// The tailored resume engine's one rule: select, reorder, reword confirmed
// facts — never invent. These tests attack that rule from the directions a
// model (or a bug) would actually break it: invented numbers, invented
// companies, unresolvable references, and quietly-partial rejection.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aiTailoringInput,
  buildDeterministicDraft,
  buildKeywordCoverage,
  extractJobSignals,
  factText,
  groundingViolationsFor,
  mergeAiTailoring,
  resolveFactRef,
  summaryTargetsJob,
  validateDraftGrounding,
  validateResumeTailoringOutput
} from '../scripts/lib/resume_tailoring.mjs';

const PROFILE = {
  identity: {
    full_name: 'Synthetic Candidate',
    email: 'synthetic@example.invalid',
    phone: '+1 555 0100',
    current_location: 'Shanghai, China',
    links: { linkedin: 'https://linkedin.example.invalid/in/synthetic', github: '', portfolio: '' }
  },
  career_goals: ['Data Scientist'],
  skills: {
    programming: ['Python', 'SQL'],
    ai_tools: ['PyTorch'],
    frameworks: [],
    cloud: ['AWS'],
    data: ['causal inference', 'A/B testing'],
    business: []
  },
  experience: [
    {
      company: 'Synthetic Retail Co',
      role: 'Data Analyst',
      dates: '2021 – 2023',
      achievements: ['Reduced checkout latency by 18% using SQL query optimization'],
      responsibilities: ['Maintained nightly reporting pipelines'],
      technologies: ['SQL', 'Airflow']
    },
    {
      company: 'Synthetic ML Lab',
      role: 'Machine Learning Engineer',
      dates: '2023 – now',
      achievements: ['Built a causal inference platform in Python serving 40 experiments per quarter'],
      responsibilities: ['Ran A/B testing reviews'],
      technologies: ['Python', 'PyTorch']
    }
  ],
  projects: [
    { name: 'Synthetic Forecaster', description: 'Demand forecasting with Python and PyTorch', results: ['Cut stockouts by 12%'], technologies: ['Python'] }
  ],
  education: [
    { institution: 'Synthetic University', degree: 'MSc', field_of_study: 'Statistics', start_date: '2018', end_date: '2020' },
    { institution: 'Synthetic College', degree: 'BSc', field_of_study: 'Mathematics', start_date: '2014', end_date: '2018' }
  ]
};

const JOB = {
  title: 'Senior Data Scientist',
  description_text: 'We need Python, causal inference and A/B testing experience. PyTorch a plus. You will design experiments.'
};

test('fact refs resolve exactly and fail closed on anything else', () => {
  assert.equal(resolveFactRef(PROFILE, 'experience[1].achievements[0]'), PROFILE.experience[1].achievements[0]);
  assert.equal(factText(resolveFactRef(PROFILE, 'skills.programming[0]')), 'Python');
  assert.equal(resolveFactRef(PROFILE, 'experience[9].achievements[0]'), undefined);
  assert.equal(resolveFactRef(PROFILE, 'constructor.prototype'), undefined, 'no prototype walking');
  assert.equal(resolveFactRef(PROFILE, 'experience[0]; drop'), undefined, 'malformed refs resolve to nothing');
});

test('the deterministic draft is grounded by construction', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const grounding = validateDraftGrounding(draft, PROFILE);
  assert.deepEqual(grounding.violations, []);
  assert.equal(grounding.ok, true);
  assert.equal(draft.provenance_complete, true);

  // Every bullet's text is literally a confirmed fact.
  const experienceBlock = draft.blocks.find(block => block.kind === 'experience');
  for (const entry of experienceBlock.entries) {
    for (const bullet of entry.bullets) {
      const source = factText(resolveFactRef(PROFILE, bullet.fact_refs[0]));
      assert.equal(bullet.text, source);
    }
  }
});

test('a job asking for Python ranks the Python experience and skills first', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const experienceBlock = draft.blocks.find(block => block.kind === 'experience');
  assert.equal(
    experienceBlock.entries[0].company, 'Synthetic ML Lab',
    'the causal-inference/Python role must outrank the SQL analyst role for this job'
  );

  const signals = extractJobSignals(JOB);
  assert.ok(signals.has('python') && signals.has('causal'));

  const skillsBlock = draft.blocks.find(block => block.kind === 'skills');
  const programming = skillsBlock.items.filter(item => item.group === 'programming');
  assert.equal(programming[0].text, 'Python', 'job-matched skill sorts before unmatched inside its group');
});

test('an AI result inventing a company is rejected in full', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const merged = mergeAiTailoring(draft, {
    summary: { text: 'Data scientist focused on causal inference and Python experiments.', fact_refs: ['career_goals[0]', 'experience[1].achievements[0]'] },
    bullet_rewrites: [
      // Grounded rewrite — fine on its own…
      { fact_ref: 'experience[1].achievements[0]', text: 'Delivered a Python causal inference platform running 40 experiments per quarter' },
      // …but this one invents an employer that is nowhere in the profile.
      { fact_ref: 'experience[0].achievements[0]', text: 'Reduced checkout latency by 18% at Google using SQL optimization' }
    ]
  }, PROFILE);

  assert.equal(merged.ai.status, 'rejected_ungrounded');
  assert.ok(merged.ai.violations.some(violation => violation.includes('unknown_proper_noun:google')));
  // All-or-nothing: the grounded rewrite must NOT survive either.
  const experienceBlock = merged.draft.blocks.find(block => block.kind === 'experience');
  for (const entry of experienceBlock.entries) {
    for (const bullet of entry.bullets) assert.equal(bullet.origin, 'verbatim');
  }
});

test('an AI result inventing a number is rejected', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const merged = mergeAiTailoring(draft, {
    summary: { text: 'Data scientist working on causal inference.', fact_refs: ['career_goals[0]', 'experience[1].achievements[0]'] },
    bullet_rewrites: [
      { fact_ref: 'experience[0].achievements[0]', text: 'Reduced checkout latency by 35% using SQL query optimization' }
    ]
  }, PROFILE);
  assert.equal(merged.ai.status, 'rejected_ungrounded');
  assert.ok(merged.ai.violations.some(violation => violation.includes('number_not_in_facts:35%')));
});

test('an AI ref that resolves to nothing is rejected', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const merged = mergeAiTailoring(draft, {
    summary: { text: 'Data scientist.', fact_refs: ['career_goals[7]'] },
    bullet_rewrites: []
  }, PROFILE);
  assert.equal(merged.ai.status, 'rejected_ungrounded');
  assert.ok(merged.ai.violations.some(violation => violation.includes('unresolvable_ref')));
});

test('a genuinely grounded AI rewrite is applied, with the original kept as provenance', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const merged = mergeAiTailoring(draft, {
    summary: {
      text: 'Data Scientist experienced in causal inference and Python, running 40 experiments per quarter.',
      fact_refs: ['career_goals[0]', 'experience[1].achievements[0]', 'skills.data[0]']
    },
    bullet_rewrites: [
      { fact_ref: 'experience[1].achievements[0]', text: 'Built a Python causal inference platform serving 40 experiments per quarter' }
    ]
  }, PROFILE);

  assert.equal(merged.ai.status, 'ok');
  assert.equal(merged.ai.rewrites_applied, 1);

  const summaryBlock = merged.draft.blocks.find(block => block.kind === 'summary');
  assert.equal(summaryBlock.items[0].origin, 'ai_rewritten');

  const experienceBlock = merged.draft.blocks.find(block => block.kind === 'experience');
  const rewritten = experienceBlock.entries.flatMap(entry => entry.bullets)
    .find(bullet => bullet.origin === 'ai_rewritten');
  assert.ok(rewritten, 'the grounded rewrite must be applied');
  assert.equal(rewritten.replaced, PROFILE.experience[1].achievements[0], 'the original fact text stays attached');

  // And the merged draft still passes full grounding.
  assert.equal(validateDraftGrounding(merged.draft, PROFILE).ok, true);
});

test('a rewrite that shrinks the fact is skipped — the original bullet survives', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const merged = mergeAiTailoring(draft, {
    summary: {
      text: 'Data Scientist experienced in causal inference and Python.',
      fact_refs: ['career_goals[0]', 'experience[1].achievements[0]', 'skills.data[0]']
    },
    bullet_rewrites: [
      // Grounded (every word is in the fact) but keeps under half the
      // content and drops "causal inference" — words the job asks for.
      { fact_ref: 'experience[1].achievements[0]', text: 'Built a platform in Python' }
    ]
  }, PROFILE, { job: JOB });

  assert.equal(merged.ai.status, 'ok', 'content loss is a quality problem, not a grounding rejection');
  assert.equal(merged.ai.rewrites_applied, 0);
  assert.equal(merged.ai.rewrites_skipped_content_loss, 1);

  const summaryBlock = merged.draft.blocks.find(block => block.kind === 'summary');
  assert.equal(summaryBlock.items[0].origin, 'ai_rewritten', 'the summary still lands');

  const experienceBlock = merged.draft.blocks.find(block => block.kind === 'experience');
  const bullets = experienceBlock.entries.flatMap(entry => entry.bullets);
  assert.ok(!bullets.some(bullet => bullet.origin === 'ai_rewritten'), 'the shrunken rewrite must not be applied');
  assert.ok(
    bullets.some(bullet => bullet.text === PROFILE.experience[1].achievements[0]),
    'the full original fact text stays on the resume'
  );
});

// --- Job targeting is enforced by code, not just asked for in the prompt ----

test('a summary that ignores the job never merges — the caller retries', () => {
  // Title word present → targeted.
  assert.equal(summaryTargetsJob('Data Scientist with causal inference experience.', JOB), true);
  // No title word, but three description signals → still targeted.
  assert.equal(summaryTargetsJob('Experienced with Python, causal inference and experiments.', JOB), true);
  // Generic filler that could sit on any resume → not targeted.
  assert.equal(summaryTargetsJob('Motivated professional with strong communication and leadership.', JOB), false);

  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const merged = mergeAiTailoring(draft, {
    summary: {
      text: 'Motivated professional with a strong background and excellent communication.',
      fact_refs: ['career_goals[0]']
    },
    bullet_rewrites: []
  }, PROFILE, { job: JOB });
  assert.equal(merged.ai.status, 'fallback_summary_not_targeted');
  assert.equal(merged.draft, draft, 'the deterministic draft stands untouched');
});

test('the deterministic summary names the job even without AI', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const summary = draft.blocks.find(block => block.kind === 'summary').items[0];
  assert.ok(summary.text.startsWith('Candidate for Senior Data Scientist.'), summary.text);
  // The job-title words are grounded via extra_grounding — the draft still
  // passes full grounding.
  assert.equal(validateDraftGrounding(draft, PROFILE).ok, true);
});

test('the summary exists for EVERY job — even a bare profile with no goals and no matching skills', () => {
  const bareProfile = {
    identity: { full_name: 'Synthetic Candidate' },
    career_goals: [],
    skills: {},
    experience: [{ company: 'A Shop', role: 'Clerk', dates: '2022', achievements: ['Stocked shelves daily'], responsibilities: [], technologies: [] }],
    projects: [],
    education: []
  };
  const draft = buildDeterministicDraft({ profile: bareProfile, job: JOB });
  const summaryBlock = draft.blocks.find(block => block.kind === 'summary');
  assert.ok(summaryBlock, 'a summary block must always exist when the job has a title');
  assert.equal(summaryBlock.items[0].text, 'Candidate for Senior Data Scientist.');
  assert.equal(summaryBlock.items[0].origin, 'job_scaffold');
  assert.equal(validateDraftGrounding(draft, bareProfile).ok, true);
});

// --- Grounding bypasses closed after adversarial review ---------------------

test('a number that is a substring of a real number is still a fabrication', () => {
  // education[1] carries 2014/2018 — "20" must not ride on them.
  const item = { origin: 'ai_rewritten', text: 'Shipped results across 20 initiatives', fact_refs: ['education[1]'] };
  const violations = groundingViolationsFor(item, PROFILE);
  assert.ok(violations.some(violation => violation.includes('number_not_in_facts:20')), JSON.stringify(violations));

  // But a fact's own number still passes whole, with or without its % sign.
  const pctProfile = structuredClone(PROFILE);
  pctProfile.experience[0].achievements = ['Grew coverage 125% using SQL query optimization'];
  const quoted = { origin: 'ai_rewritten', text: 'Grew coverage 125 percent using SQL query optimization', fact_refs: ['experience[0].achievements[0]'] };
  assert.deepEqual(groundingViolationsFor(quoted, pctProfile), []);
  const smuggled = { origin: 'ai_rewritten', text: 'Grew coverage across 12 SQL query optimization projects', fact_refs: ['experience[0].achievements[0]'] };
  assert.ok(groundingViolationsFor(smuggled, pctProfile).some(violation => violation.includes('number_not_in_facts:12')));
});

test('full-width digits are the same claim as ASCII digits', () => {
  const item = { origin: 'ai_rewritten', text: 'Reduced checkout latency ５０％ using SQL query optimization', fact_refs: ['experience[0].achievements[0]'] };
  const violations = groundingViolationsFor(item, PROFILE);
  assert.ok(violations.some(violation => violation.includes('number_not_in_facts:50%')), JSON.stringify(violations));
});

test('CJK text must appear verbatim in the cited facts', () => {
  const fabricated = {
    origin: 'ai_rewritten',
    text: 'Built a causal inference platform in Python serving 40 experiments per quarter. 我曾在谷歌担任高级工程师五年。',
    fact_refs: ['experience[1].achievements[0]']
  };
  const violations = groundingViolationsFor(fabricated, PROFILE);
  assert.ok(violations.some(violation => violation.startsWith('ungrounded_cjk_text')), JSON.stringify(violations));

  const cjkProfile = structuredClone(PROFILE);
  cjkProfile.experience[1].achievements = ['负责搭建因果推断平台并服务实验团队'];
  const quoted = { origin: 'ai_rewritten', text: '负责搭建因果推断平台并服务实验团队', fact_refs: ['experience[1].achievements[0]'] };
  assert.deepEqual(groundingViolationsFor(quoted, cjkProfile), []);
});

test('a short fabricated clause cannot hide inside a long grounded paragraph', () => {
  const item = {
    origin: 'ai_rewritten',
    text: 'Built a causal inference platform in Python serving 40 experiments per quarter, building causal inference '
      + 'experiments in Python quarter after quarter and serving the platform experiments, '
      + 'as a licensed professional engineer holding an active federal clearance.',
    fact_refs: ['experience[1].achievements[0]']
  };
  const violations = groundingViolationsFor(item, PROFILE);
  assert.ok(violations.some(violation => violation.startsWith('ungrounded_run')), JSON.stringify(violations));
});

test('capitalized names with internal punctuation are checked, not skipped', () => {
  const item = { origin: 'ai_rewritten', text: 'Built pipelines in SQL at AT&T for query optimization', fact_refs: ['experience[0].achievements[0]'] };
  const violations = groundingViolationsFor(item, PROFILE);
  assert.ok(violations.some(violation => violation.includes('unknown_proper_noun:at&t')), JSON.stringify(violations));

  // A punctuated name the facts really contain still passes.
  const attProfile = structuredClone(PROFILE);
  attProfile.experience[0].company = 'AT&T Research';
  const legit = { origin: 'ai_rewritten', text: 'Reduced checkout latency by 18% using SQL query optimization at AT&T', fact_refs: ['experience[0].achievements[0]', 'experience[0]'] };
  assert.deepEqual(groundingViolationsFor(legit, attProfile), []);
});

test('refs outside the offered inventory reject the AI result', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const merged = mergeAiTailoring(draft, {
    summary: {
      // identity resolves in the profile but was never offered to the model —
      // citing it would launder the candidate's name into the grounding pool.
      text: 'Data Scientist experienced in causal inference and Python.',
      fact_refs: ['career_goals[0]', 'identity']
    },
    bullet_rewrites: []
  }, PROFILE, { job: JOB });
  assert.equal(merged.ai.status, 'rejected_ungrounded');
  assert.ok(merged.ai.violations.some(violation => violation.includes('ref_not_offered:identity')), JSON.stringify(merged.ai));

  // A SUB-path of an offered fact narrows the grounding source — allowed.
  const subPath = mergeAiTailoring(draft, {
    summary: {
      text: 'Data Scientist experienced in causal inference and Python.',
      fact_refs: ['career_goals[0]', 'experience[1].achievements[0]', 'skills.data[0]']
    },
    bullet_rewrites: [
      { fact_ref: 'experience[1].achievements[0]', text: 'Built a Python causal inference platform serving 40 experiments per quarter' }
    ]
  }, PROFILE, { job: JOB });
  assert.equal(subPath.ai.status, 'ok', JSON.stringify(subPath.ai));
});

test('the AI input contains only citable facts, bounded', () => {
  const input = aiTailoringInput({ profile: PROFILE, job: JOB });
  assert.ok(input.facts.length > 0 && input.facts.length <= 200);
  for (const fact of input.facts) {
    assert.ok(fact.ref && fact.text);
    assert.notEqual(resolveFactRef(PROFILE, fact.ref), undefined, `${fact.ref} must resolve`);
  }
  // No identity contact details go to the model: the resume header does not
  // need AI, so the email/phone never leave the machine for this task.
  const serialized = JSON.stringify(input);
  assert.ok(!serialized.includes('synthetic@example.invalid'));
  assert.ok(!serialized.includes('555 0100'));
});

test('malformed AI output shapes are rejected before grounding', () => {
  assert.equal(validateResumeTailoringOutput(null).ok, false);
  assert.equal(validateResumeTailoringOutput({ summary: { text: 'x' } }).ok, false);
  assert.equal(validateResumeTailoringOutput({ summary: { text: 'x', fact_refs: ['a'] }, bullet_rewrites: [{}] }).ok, false);
  assert.equal(validateResumeTailoringOutput({ summary: { text: 'x', fact_refs: ['a'] }, bullet_rewrites: [] }).ok, true);
});

test('education is never trimmed by tailoring', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const education = draft.blocks.find(block => block.kind === 'education');
  assert.equal(education.entries.length, 2, 'leaving out a degree is the user\'s call, not the tailorer\'s');
});

// --- Keyword coverage (the deterministic reviewer) -------------------------

test('posting keywords are classified covered / have-it / genuine gap', () => {
  const job = {
    title: 'Senior Data Scientist',
    description_text: 'Python required, Python daily. Kubernetes required. Kubernetes deployments. '
      + 'Causal inference and causal analysis. Airflow pipelines, Airflow scheduling.'
  };
  const draft = buildDeterministicDraft({ profile: PROFILE, job });
  const coverage = buildKeywordCoverage({ profile: PROFILE, job, draft });

  const byKeyword = bucket => new Set(coverage[bucket].map(entry => entry.keyword));
  // python and causal are in profile AND in the draft.
  assert.ok(byKeyword('covered').has('python'));
  assert.ok(byKeyword('covered').has('causal'));
  // airflow is a confirmed technology of the analyst role, but technologies are
  // not rendered as draft text — so it lands in "have it", with proof.
  assert.ok(byKeyword('missing_have_it').has('airflow'));
  const airflow = coverage.missing_have_it.find(entry => entry.keyword === 'airflow');
  assert.ok(airflow.fact_refs.length > 0, 'have-it must cite the facts that prove it');
  for (const ref of airflow.fact_refs) {
    assert.notEqual(resolveFactRef(PROFILE, ref), undefined);
  }
  // kubernetes appears nowhere in the profile: a genuine gap.
  assert.ok(byKeyword('missing_gap').has('kubernetes'));
  assert.ok(coverage.coverage_ratio > 0 && coverage.coverage_ratio < 1);
});

test('a genuine gap is never stuffed into the draft', () => {
  const job = {
    title: 'Kubernetes Platform Engineer',
    description_text: 'Kubernetes, Kubernetes, Kubernetes. Terraform daily. Terraform modules.'
  };
  const draft = buildDeterministicDraft({ profile: PROFILE, job });
  const coverage = buildKeywordCoverage({ profile: PROFILE, job, draft });

  assert.ok(coverage.missing_gap.some(entry => entry.keyword === 'kubernetes'));
  assert.ok(coverage.missing_gap.some(entry => entry.keyword === 'terraform'));

  // The honesty property: the gap stays in the report and out of the draft's
  // CAPABILITY content. The summary's "Candidate for <job title>." line is an
  // INTENT statement built from the posting's own words (same allowance the
  // AI summary has via extra_grounding) — it claims application, not skill.
  // Everything else must never gain words the profile lacks.
  const capabilityBlocks = structuredClone(draft.blocks);
  for (const block of capabilityBlocks) {
    if (block.kind !== 'summary') continue;
    for (const item of block.items) {
      item.text = item.text.replace(/^Candidate for [^.]*\.\s*/, '');
      delete item.extra_grounding;
    }
  }
  const allText = JSON.stringify(capabilityBlocks).toLowerCase();
  assert.equal(allText.includes('kubernetes'), false, 'capability content must not gain words the profile lacks');
  assert.equal(allText.includes('terraform'), false);

  // And the intent line itself is exactly the title, nothing more: no gap
  // keyword leaks into skills, experience or any other block.
  const summaryText = draft.blocks.find(block => block.kind === 'summary').items[0].text;
  assert.ok(summaryText.startsWith('Candidate for Kubernetes Platform Engineer.'), summaryText);
});

// --- Bullet budget and cut provenance --------------------------------------

const BUSY_PROFILE = {
  ...PROFILE,
  experience: [{
    company: 'Synthetic Everything Co',
    role: 'Engineer',
    achievements: [
      'Built a causal inference platform in Python serving 40 experiments per quarter',
      'Built a causal inference platform in Python for 40 experiments each quarter',
      'Organized the annual office party for 200 attendees',
      'Maintained the coffee machine rota',
      'Reduced checkout latency by 18% using SQL query optimization'
    ],
    responsibilities: [],
    technologies: ['Python']
  }]
};

test('the bullet budget cuts the least relevant lines and records every cut', () => {
  // A job that genuinely values both the causal work and the SQL latency win,
  // so relevance — not tie-order luck — decides what survives the budget.
  const budgetJob = {
    title: 'Data Engineer',
    description_text: 'SQL query optimization, latency reduction, and Python causal inference pipelines.'
  };
  const draft = buildDeterministicDraft({
    profile: BUSY_PROFILE,
    job: budgetJob,
    options: { bullet_budget: { per_entry: 2, total: 24 } }
  });
  const entry = draft.blocks.find(block => block.kind === 'experience').entries[0];
  assert.equal(entry.bullets.length, 2);

  // The quantified, job-relevant achievement survives; office trivia does not.
  assert.ok(entry.bullets.some(bullet => bullet.text.includes('causal inference platform')));
  assert.equal(entry.bullets.some(bullet => bullet.text.includes('office party')), false);

  // Every cut line is on the record with resolvable provenance.
  assert.ok(draft.cut_lines.length >= 3);
  for (const cut of draft.cut_lines) {
    assert.ok(['duplicate', 'over_entry_budget', 'over_total_budget'].includes(cut.reason));
    assert.notEqual(resolveFactRef(BUSY_PROFILE, cut.fact_refs[0]), undefined, 'cut lines must stay restorable');
  }
});

test('near-duplicate bullets are cut as duplicates, not kept twice', () => {
  const draft = buildDeterministicDraft({
    profile: BUSY_PROFILE,
    job: JOB,
    options: { bullet_budget: { per_entry: 5, total: 24 } }
  });
  const duplicates = draft.cut_lines.filter(cut => cut.reason === 'duplicate');
  assert.ok(
    duplicates.length >= 1,
    'the two near-identical causal/Python bullets must not both survive'
  );
  assert.ok(duplicates[0].similar_to, 'a duplicate cut names what it duplicated');
});

test('the default budget does not change existing drafts', () => {
  const unbudgeted = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  assert.deepEqual(unbudgeted.cut_lines, [], 'small profiles must be untouched by default limits');
});
