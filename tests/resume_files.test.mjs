// The tailored-resume file chain, verified by reading the files back.
//
// A generated DOCX is only proven when its text layer can be extracted and
// checked — so these tests run every generated file through the SAME reader
// the product uses for uploaded resumes. If Word can't read what we write,
// neither can this reader, and the suite fails.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildResumeDocx, createZipArchive } from '../scripts/lib/docx_writer.mjs';
import { draftRenderModel, renderResumeHtml } from '../scripts/lib/resume_render.mjs';
import { extractDocxText, zipEntryNames } from '../scripts/lib/resume_document_intelligence.mjs';
import { buildDeterministicDraft } from '../scripts/lib/resume_tailoring.mjs';

const PROFILE = {
  identity: {
    full_name: 'Synthetic Candidate',
    email: 'synthetic@example.invalid',
    phone: '+1 555 0100',
    current_location: 'Shanghai, China',
    links: { linkedin: 'https://linkedin.example.invalid/in/synthetic' }
  },
  career_goals: ['Data Scientist'],
  skills: { programming: ['Python', 'SQL'], ai_tools: ['PyTorch'], frameworks: [], cloud: [], data: ['causal inference'], business: [] },
  experience: [{
    company: 'Synthetic ML Lab',
    role: 'Machine Learning Engineer',
    dates: '2023 – now',
    achievements: ['Built a causal inference platform in Python serving 40 experiments per quarter'],
    responsibilities: [],
    technologies: ['Python']
  }],
  projects: [{ name: 'Synthetic Forecaster', description: 'Demand forecasting with Python', results: ['Cut stockouts by 12%'] }],
  education: [{ institution: '合成大学', degree: 'MSc', field_of_study: 'Statistics', start_date: '2018', end_date: '2020' }]
};

const JOB = { title: 'Senior Data Scientist', description_text: 'Python and causal inference experiments.' };

test('the ZIP container is readable by the product\'s own reader', () => {
  const zip = createZipArchive([
    { name: 'hello.txt', data: 'hello world' },
    { name: 'nested/file.xml', data: '<a>中文</a>' }
  ]);
  assert.deepEqual(zipEntryNames(zip), ['hello.txt', 'nested/file.xml']);
});

test('a generated DOCX round-trips through the resume text extractor', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const model = draftRenderModel(draft);
  const docx = buildResumeDocx(model);

  const extracted = extractDocxText(docx);
  assert.equal(extracted.format, 'docx');
  const flat = extracted.text;

  // Identity survives as literal text (the ATS-parseability property).
  assert.ok(flat.includes('Synthetic Candidate'), 'the name must survive as text');
  assert.ok(flat.includes('synthetic@example.invalid'), 'the email must survive as text');
  assert.ok(flat.includes('+1 555 0100'), 'the phone must survive as text');

  // The tailored content is all there.
  assert.ok(flat.includes('Machine Learning Engineer'));
  assert.ok(flat.includes('Synthetic ML Lab'));
  assert.ok(flat.includes('Built a causal inference platform in Python serving 40 experiments per quarter'));
  assert.ok(flat.includes('Cut stockouts by 12%'));
  assert.ok(flat.includes('合成大学'), 'CJK text must survive, not tofu');

  // Section structure exists.
  for (const title of ['Summary', 'Skills', 'Experience', 'Projects', 'Education']) {
    assert.ok(flat.includes(title), `section "${title}" must be present`);
  }
});

test('cut lines never reach the rendered file', () => {
  const busyProfile = {
    ...PROFILE,
    experience: [{
      company: 'Synthetic Everything Co',
      role: 'Engineer',
      achievements: [
        'Built a causal inference platform in Python serving 40 experiments per quarter',
        'Maintained the coffee machine rota'
      ],
      responsibilities: [],
      technologies: ['Python']
    }]
  };
  const draft = buildDeterministicDraft({
    profile: busyProfile, job: JOB, options: { bullet_budget: { per_entry: 1, total: 24 } }
  });
  assert.ok(draft.cut_lines.length >= 1, 'the budget must have cut something');

  const model = draftRenderModel(draft);
  const flat = extractDocxText(buildResumeDocx(model)).text;
  assert.ok(flat.includes('causal inference platform'));
  assert.equal(
    flat.includes('coffee machine'), false,
    'a cut line lives in the review block, not in the printed resume'
  );
});

test('XML-hostile characters in facts are escaped, not executed', () => {
  const spikyProfile = {
    ...PROFILE,
    experience: [{
      company: 'A&B <Research> Co',
      role: 'R&D "Lead"',
      achievements: ['Shipped <feature> & improved A&B pipeline'],
      responsibilities: [], technologies: []
    }]
  };
  const draft = buildDeterministicDraft({ profile: spikyProfile, job: JOB });
  const docx = buildResumeDocx(draftRenderModel(draft));
  const flat = extractDocxText(docx).text;
  assert.ok(flat.includes('A&B <Research> Co'), 'special characters must round-trip literally');
  assert.ok(flat.includes('Shipped <feature> & improved A&B pipeline'));
});

test('the HTML render carries the same content as the DOCX', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  const model = draftRenderModel(draft);
  const html = renderResumeHtml(model);
  const docxText = extractDocxText(buildResumeDocx(model)).text;

  for (const marker of [
    'Synthetic Candidate',
    'Built a causal inference platform in Python serving 40 experiments per quarter',
    '合成大学'
  ]) {
    assert.ok(html.includes(marker), `HTML missing: ${marker}`);
    assert.ok(docxText.includes(marker), `DOCX missing: ${marker}`);
  }
  // And hostile input stays escaped in HTML.
  assert.equal(html.includes('<script'), false);
});

test('an AI-rewritten draft renders its rewritten text, with the original preserved in data only', () => {
  const draft = buildDeterministicDraft({ profile: PROFILE, job: JOB });
  // Simulate an accepted AI rewrite the way mergeAiTailoring stores it.
  const experience = draft.blocks.find(block => block.kind === 'experience');
  const original = experience.entries[0].bullets[0];
  experience.entries[0].bullets[0] = {
    origin: 'ai_rewritten',
    text: 'Delivered a Python causal inference platform running 40 experiments per quarter',
    fact_refs: original.fact_refs,
    relevance: original.relevance,
    replaced: original.text
  };

  const flat = extractDocxText(buildResumeDocx(draftRenderModel(draft))).text;
  assert.ok(flat.includes('Delivered a Python causal inference platform'));
  assert.equal(
    flat.includes(original.text), false,
    'the replaced original belongs to provenance, not to the printed page'
  );
});
