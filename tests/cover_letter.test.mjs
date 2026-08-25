// The cover letter engine's promises: grounded in confirmed facts, honest
// about genuine gaps, and structurally incapable of arguing against its own
// applicant — the defect the old deterministic template actually shipped
// (it pasted negative career_growth_value verdicts into the letter body).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aiCoverLetterInput,
  buildDeterministicCoverLetter,
  mergeAiCoverLetter,
  validateCoverLetterGrounding,
  validateCoverLetterOutput
} from '../scripts/lib/cover_letter.mjs';

const PROFILE = {
  identity: { full_name: 'Synthetic Candidate', email: 'synthetic@example.invalid', phone: '+1 555 0100', links: {} },
  career_goals: ['Data Science'],
  skills: {
    programming: ['Python', 'SQL'],
    ai_tools: ['PyTorch'],
    frameworks: [], cloud: [], business: [],
    data: ['causal inference']
  },
  experience: [{
    company: 'Synthetic ML Lab',
    role: 'Machine Learning Engineer',
    achievements: ['Built a causal inference platform in Python serving 40 experiments per quarter'],
    responsibilities: [],
    technologies: ['Python']
  }],
  projects: [],
  education: []
};

const JOB = {
  title: 'Senior Data Scientist',
  company: 'Synthetic Employer',
  description_text: 'Python daily, Python pipelines. Causal inference required, causal analysis. Kubernetes required, Kubernetes clusters.'
};

test('the deterministic letter is grounded, addressed, and provenance-complete', () => {
  const letter = buildDeterministicCoverLetter({ profile: PROFILE, job: JOB });
  const grounding = validateCoverLetterGrounding(letter, PROFILE, JOB);
  assert.deepEqual(grounding.violations, []);
  assert.equal(grounding.ok, true);

  const flat = letter.paragraphs.map(paragraph => paragraph.text).join('\n');
  assert.ok(flat.includes('Synthetic Employer'), 'the letter addresses the actual company');
  assert.ok(flat.includes('Senior Data Scientist'), 'the letter names the actual role');
  assert.ok(flat.includes('Synthetic Candidate'), 'the letter signs with the confirmed name');
  // The strongest job-relevant achievement is quoted verbatim.
  assert.ok(flat.includes('Built a causal inference platform in Python serving 40 experiments per quarter'));

  // Claim-bearing paragraphs carry provenance.
  for (const paragraph of letter.paragraphs) {
    if (['assembled', 'verbatim'].includes(paragraph.origin)) {
      assert.ok(paragraph.fact_refs?.length, `${paragraph.origin} paragraph must cite facts`);
    }
  }
});

test('a genuine gap becomes an honest bridge, never a claim', () => {
  const letter = buildDeterministicCoverLetter({ profile: PROFILE, job: JOB });
  assert.equal(letter.honest_gap, 'kubernetes', 'the title-frequency gap is named');

  const bridge = letter.paragraphs.find(paragraph => paragraph.origin === 'honest_bridge');
  assert.ok(bridge, 'the letter must contain the honest bridge');
  assert.match(bridge.text, /have not worked with kubernetes/i);
  // The bridge admits the gap; it must not smuggle in ability claims or numbers.
  assert.doesNotMatch(bridge.text, /\d/);
  assert.doesNotMatch(bridge.text, /experienced|proficient|expert|skilled/i);
});

test('the letter never contains job-match commentary — the old template defect', () => {
  // A job record poisoned with the analysis fields the old template used to
  // paste into the letter. The engine must not read any of them.
  const poisonedJob = {
    ...JOB,
    hybrid_match: {
      career_growth_value: 'This is a contract position. It may not provide the same long-term career trajectory.',
      weaknesses: ['No Kubernetes experience'],
      recommendation: 'Do not apply'
    },
    ai_enrichment: { gaps: ['kubernetes'], summary: 'Weak fit for this role.' }
  };
  const letter = buildDeterministicCoverLetter({ profile: PROFILE, job: poisonedJob });
  const flat = letter.paragraphs.map(paragraph => paragraph.text).join(' ').toLowerCase();

  for (const marker of ['career trajectory', 'may not provide', 'do not apply', 'weak fit', 'weakness']) {
    assert.equal(flat.includes(marker), false, `the letter leaked match commentary: "${marker}"`);
  }
  assert.equal(validateCoverLetterGrounding(letter, PROFILE, poisonedJob).ok, true);
});

// A grounded body long enough to clear the shape gate, built only from the
// profile's fact words plus the job's own identity words.
const GROUNDED_BODY = [
  {
    text: 'At Synthetic ML Lab I built a causal inference platform in Python serving 40 experiments per quarter. '
      + 'Building and serving causal inference experiments in Python, quarter after quarter, is the experience I bring as a Machine Learning Engineer. '
      + 'The causal inference platform I built in Python was serving experiments quarter after quarter, and serving those experiments '
      + 'was building the platform for causal inference in Python at Synthetic ML Lab, experiment after experiment.',
    fact_refs: ['experience[0].achievements[0]', 'experience[0]']
  },
  {
    text: 'My background is in Data Science, working with Python, SQL, PyTorch, and causal inference. '
      + 'The Senior Data Scientist position at Synthetic Employer calls for Python and causal inference, and I would bring exactly that Python and causal inference background to Synthetic Employer.',
    fact_refs: ['career_goals[0]', 'skills.programming[0]', 'skills.programming[1]', 'skills.ai_tools[0]', 'skills.data[0]']
  }
];

test('an AI rewrite inventing a skill is rejected in full', () => {
  const letter = buildDeterministicCoverLetter({ profile: PROFILE, job: JOB });
  const merged = mergeAiCoverLetter(letter, {
    paragraphs: [
      // Grounded and substantial — fine on its own…
      GROUNDED_BODY[0],
      // …but this paragraph claims Kubernetes expertise the profile lacks.
      {
        text: 'I am also deeply experienced with Kubernetes cluster operations, having administered production Kubernetes clusters, '
          + 'tuned Kubernetes networking, and led Kubernetes migrations for multiple enterprise container platforms across several organizations.',
        fact_refs: ['skills.programming[0]']
      }
    ]
  }, PROFILE, JOB);

  assert.equal(merged.ai.status, 'rejected_ungrounded');
  // All-or-nothing: the grounded paragraph did not survive either.
  assert.equal(
    merged.letter.paragraphs.some(paragraph => paragraph.origin === 'ai_rewritten'),
    false
  );
});

test('a grounded AI rewrite replaces the body but keeps opening, bridge and closing', () => {
  const letter = buildDeterministicCoverLetter({ profile: PROFILE, job: JOB });
  const merged = mergeAiCoverLetter(letter, { paragraphs: GROUNDED_BODY }, PROFILE, JOB);

  assert.equal(merged.ai.status, 'ok', JSON.stringify(merged.ai));
  const origins = merged.letter.paragraphs.map(paragraph => paragraph.origin);
  assert.ok(origins.includes('ai_rewritten'));
  assert.ok(origins.includes('honest_bridge'), 'the honest bridge survives AI rewriting');
  assert.ok(merged.letter.paragraphs[0].text.startsWith('Dear Synthetic Employer'));
  assert.ok(merged.letter.paragraphs.at(-1).text.includes('Synthetic Candidate'));
  assert.equal(validateCoverLetterGrounding(merged.letter, PROFILE, JOB).ok, true);
});

test('the AI body may name the job title and company — data, not fabrication', () => {
  // GROUNDED_BODY[1] says "Senior Data Scientist position at Synthetic
  // Employer" — words that exist nowhere in the profile. They must pass
  // grounding via the job-identity allowance, and ONLY those words: the
  // Kubernetes test above proves other unknown words still reject.
  const letter = buildDeterministicCoverLetter({ profile: PROFILE, job: JOB });
  const merged = mergeAiCoverLetter(letter, { paragraphs: GROUNDED_BODY }, PROFILE, JOB);
  assert.equal(merged.ai.status, 'ok', JSON.stringify(merged.ai));
  const aiParagraphs = merged.letter.paragraphs.filter(paragraph => paragraph.origin === 'ai_rewritten');
  assert.ok(aiParagraphs.some(paragraph => paragraph.text.includes('Synthetic Employer')));
});

test('a grounded but thin AI body is not allowed to shrink the letter', () => {
  // A profile whose deterministic body is substantial: the floor scales up
  // with it, so an AI body that clears the absolute minimum but would still
  // DOWNGRADE the letter falls back to the deterministic version.
  const pool = [];
  for (const first of ['al', 'be', 'ce', 'de', 'el', 'fo', 'ga', 'he', 'in', 'jo']) {
    for (const second of ['pha', 'ta', 'ra', 'ma', 'na', 'ka', 'sa', 'la']) pool.push(`syn${first}${second}`);
  }
  const richProfile = structuredClone(PROFILE);
  richProfile.experience[0].achievements = [
    `Built a causal inference platform in Python serving 40 experiments per quarter covering ${pool.slice(0, 40).join(' ')}`,
    `Delivered causal analysis training covering ${pool.slice(40, 80).join(' ')}`
  ];
  richProfile.education = [{
    institution: 'Synthetic University', degree: 'BSc', field_of_study: 'Statistics',
    start_date: '2016', end_date: '2020'
  }];
  const letter = buildDeterministicCoverLetter({ profile: richProfile, job: JOB });
  const merged = mergeAiCoverLetter(letter, {
    paragraphs: [
      { text: `I built a causal inference platform in Python serving 40 experiments per quarter covering ${pool.slice(0, 36).join(' ')}`, fact_refs: ['experience[0].achievements[0]'] },
      { text: `Delivered causal analysis training covering ${pool.slice(40, 78).join(' ')}`, fact_refs: ['experience[0].achievements[1]'] }
    ]
  }, richProfile, JOB);

  assert.equal(merged.ai.status, 'fallback_thin_output', JSON.stringify(merged.ai));
  // The deterministic letter stands untouched.
  assert.equal(merged.letter.paragraphs.some(paragraph => paragraph.origin === 'ai_rewritten'), false);
  assert.equal(validateCoverLetterGrounding(merged.letter, richProfile, JOB).ok, true);
});

test('confirmed-fact words pass even when miscited; moved numbers never do', () => {
  const gradProfile = structuredClone(PROFILE);
  gradProfile.projects = [{
    name: 'Churn Model',
    description: 'Predicted customer churn with Python using causal inference features',
    results: [],
    technologies: ['Python']
  }];
  const letter = buildDeterministicCoverLetter({ profile: gradProfile, job: JOB });

  // "Churn Model" is a user-confirmed fact the paragraph forgot to cite —
  // honest words, sloppy provenance. The letter must still land.
  const miscited = mergeAiCoverLetter(letter, {
    paragraphs: [
      GROUNDED_BODY[0],
      {
        text: 'My background is in Data Science with Python, SQL, PyTorch, and causal inference — my Churn Model project predicted customer churn with Python using causal inference features for Synthetic Employer review.',
        fact_refs: ['career_goals[0]', 'skills.programming[0]', 'skills.data[0]']
      }
    ]
  }, gradProfile, JOB);
  assert.equal(miscited.ai.status, 'ok', JSON.stringify(miscited.ai));

  // The 40 belongs to the platform fact; attaching it to skills is a false
  // claim even though 40 exists in the profile.
  const movedNumber = mergeAiCoverLetter(letter, {
    paragraphs: [
      GROUNDED_BODY[0],
      {
        text: 'My background is in Data Science with Python, SQL, PyTorch and causal inference, and my Churn Model project predicted customer churn with Python across 40 causal inference features.',
        fact_refs: ['career_goals[0]', 'skills.programming[0]', 'projects[0]']
      }
    ]
  }, gradProfile, JOB);
  assert.equal(movedNumber.ai.status, 'rejected_ungrounded');
  assert.ok(movedNumber.ai.violations.some(violation => violation.includes('number_not_in_facts:40')), JSON.stringify(movedNumber.ai));
});

test('the AI input carries only citable facts and no contact details', () => {
  const letter = buildDeterministicCoverLetter({ profile: PROFILE, job: JOB });
  const input = aiCoverLetterInput({ profile: PROFILE, job: JOB, letter });
  assert.ok(input.facts.length > 0);
  const serialized = JSON.stringify(input);
  assert.equal(serialized.includes('synthetic@example.invalid'), false);
  assert.equal(serialized.includes('555 0100'), false);
});

test('malformed or thin AI output shapes are rejected before grounding', () => {
  assert.equal(validateCoverLetterOutput(null).ok, false);
  assert.equal(validateCoverLetterOutput({ paragraphs: [{ text: 'x' }] }).ok, false);
  assert.equal(validateCoverLetterOutput({ paragraphs: [{ text: 'x', fact_refs: [] }] }).ok, false);
  // One thin sentence is not a cover letter — the Apple regression this
  // guards against was a single 13-word body paragraph.
  assert.equal(validateCoverLetterOutput({ paragraphs: [{ text: 'x', fact_refs: ['a'] }] }).ok, false, 'single paragraph rejected');
  assert.equal(
    validateCoverLetterOutput({
      paragraphs: [
        { text: 'short one', fact_refs: ['a'] },
        { text: 'short two', fact_refs: ['b'] }
      ]
    }).ok,
    false,
    'two thin paragraphs rejected'
  );
  const longText = Array.from({ length: 30 }, () => 'grounded factual words').join(' ');
  assert.equal(
    validateCoverLetterOutput({
      paragraphs: [
        { text: longText, fact_refs: ['a'] },
        { text: longText, fact_refs: ['b'] }
      ]
    }).ok,
    true,
    'a substantial 2-4 paragraph body passes'
  );
});

test('the bridge names the phrase the posting wrote, never a shredded fragment', () => {
  // The shipped defect: "I have not worked with full yet" for a Full Stack
  // posting. The bridge must reassemble "full stack" or stay silent.
  const fullStackJob = {
    title: 'Full Stack Engineer',
    company: 'Synthetic Employer',
    description_text: 'Build full stack features. Ship full stack code.'
  };
  const letter = buildDeterministicCoverLetter({ profile: PROFILE, job: fullStackJob });
  assert.equal(letter.honest_gap, 'full stack');
  const bridge = letter.paragraphs.find(paragraph => paragraph.origin === 'honest_bridge');
  assert.match(bridge.text, /have not worked with full stack yet/i);
});

test('education and projects strengthen the deterministic body and the AI facts', () => {
  const gradProfile = structuredClone(PROFILE);
  gradProfile.education = [{
    institution: 'Synthetic University', degree: 'BSc', field_of_study: 'Statistics',
    start_date: '2016', end_date: '2020'
  }];
  gradProfile.projects = [{
    name: 'Churn Model',
    description: 'Predicted customer churn with Python using causal inference features',
    results: [],
    technologies: ['Python']
  }];

  const letter = buildDeterministicCoverLetter({ profile: gradProfile, job: JOB });
  assert.equal(validateCoverLetterGrounding(letter, gradProfile, JOB).ok, true);

  const education = letter.paragraphs.find(paragraph =>
    paragraph.origin === 'assembled' && (paragraph.fact_refs || []).includes('education[0]'));
  assert.ok(education, 'the confirmed degree appears in the letter');
  for (const piece of ['BSc', 'Statistics', 'Synthetic University', '2020']) {
    assert.ok(education.text.includes(piece), `education paragraph must carry ${piece}`);
  }

  // The job-relevant project description is quotable evidence.
  const evidenceRefs = letter.paragraphs
    .filter(paragraph => paragraph.origin === 'verbatim')
    .flatMap(paragraph => paragraph.fact_refs);
  assert.ok(evidenceRefs.includes('projects[0].description'), `project evidence missing: ${evidenceRefs}`);

  // And the AI sees projects and education as citable facts.
  const input = aiCoverLetterInput({ profile: gradProfile, job: JOB, letter });
  const refs = input.facts.map(fact => fact.ref);
  assert.ok(refs.includes('projects[0]'));
  assert.ok(refs.includes('education[0]'));
});

test('a digit-bearing gap is skipped — the letter must pass its own validator', () => {
  const python3Job = {
    title: 'Senior Data Scientist',
    company: 'Synthetic Employer',
    description_text: 'Ship python3 services. Maintain python3 tooling. Causal inference welcome.'
  };
  const letter = buildDeterministicCoverLetter({ profile: PROFILE, job: python3Job });
  assert.equal(letter.honest_gap, '', 'python3 cannot be bridged without a digit in the bridge');
  assert.equal(letter.paragraphs.some(paragraph => paragraph.origin === 'honest_bridge'), false);
  assert.equal(validateCoverLetterGrounding(letter, PROFILE, python3Job).ok, true);
});

test("the match-commentary scan never fires on the user's own verbatim achievements", () => {
  const securityProfile = structuredClone(PROFILE);
  securityProfile.experience[0].achievements = ['Identified weakness patterns in authentication flows and fixed them'];
  const letter = buildDeterministicCoverLetter({ profile: securityProfile, job: JOB });
  const grounding = validateCoverLetterGrounding(letter, securityProfile, JOB);
  assert.deepEqual(grounding.violations, []);
  assert.equal(grounding.ok, true);
});

test('a name-less profile still gets exactly one closing, at the end', () => {
  const namelessProfile = structuredClone(PROFILE);
  namelessProfile.identity.full_name = '';
  const letter = buildDeterministicCoverLetter({ profile: namelessProfile, job: JOB });
  const merged = mergeAiCoverLetter(letter, { paragraphs: GROUNDED_BODY }, namelessProfile, JOB);
  assert.equal(merged.ai.status, 'ok', JSON.stringify(merged.ai));
  const closings = merged.letter.paragraphs.filter(paragraph => paragraph.text.startsWith('Thank you'));
  assert.equal(closings.length, 1, 'the closing must not be duplicated around the AI body');
  assert.ok(merged.letter.paragraphs.at(-1).text.startsWith('Thank you'));
});

test('claiming employment at the target company is rejected', () => {
  const globexJob = { ...JOB, company: 'Globex' };
  const letter = buildDeterministicCoverLetter({ profile: PROFILE, job: globexJob });
  const merged = mergeAiCoverLetter(letter, {
    paragraphs: [
      GROUNDED_BODY[0],
      {
        text: 'My background is in Data Science, working with Python, SQL, PyTorch, and causal inference. '
          + 'I previously worked at Globex building causal inference experiments in Python serving experiments per quarter.',
        fact_refs: ['career_goals[0]', 'skills.programming[0]', 'skills.data[0]', 'experience[0].achievements[0]']
      }
    ]
  }, PROFILE, globexJob);
  assert.equal(merged.ai.status, 'rejected_ungrounded');
  assert.ok(
    merged.ai.violations.some(violation => violation.includes('implied_employment_at_target_company')),
    JSON.stringify(merged.ai)
  );
});

test('a profile with no gaps produces no bridge rather than an empty apology', () => {
  const fullMatchJob = {
    title: 'Python Data Engineer',
    company: 'Synthetic Employer',
    description_text: 'Python pipelines, Python daily. Causal inference required, causal analysis daily.'
  };
  const letter = buildDeterministicCoverLetter({ profile: PROFILE, job: fullMatchJob });
  assert.equal(letter.honest_gap, '');
  assert.equal(letter.paragraphs.some(paragraph => paragraph.origin === 'honest_bridge'), false);
});
