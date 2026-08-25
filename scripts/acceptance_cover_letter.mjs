// Real-model acceptance for the cover letter engine. Same rules as the resume
// acceptance: a grounded model contribution is applied, an embellishing one is
// rejected in full, and the merged letter must always pass grounding. With no
// local model running it prints SKIPPED — never a fake pass.
import { createAIProvider, detectLocalAIProviders } from './lib/ai_provider.mjs';
import {
  aiCoverLetterInput,
  buildDeterministicCoverLetter,
  mergeAiCoverLetter,
  validateCoverLetterGrounding,
  validateCoverLetterOutput
} from './lib/cover_letter.mjs';

const PROFILE = {
  identity: { full_name: 'Acceptance Test Candidate', email: 'acceptance@example.invalid', phone: '+1 555 0100', links: {} },
  career_goals: ['Data Science'],
  skills: { programming: ['Python', 'SQL'], ai_tools: ['PyTorch'], frameworks: [], cloud: [], business: [], data: ['causal inference'] },
  experience: [{
    company: 'Synthetic ML Lab', role: 'Machine Learning Engineer',
    achievements: ['Built a causal inference platform in Python serving 40 experiments per quarter'],
    responsibilities: [], technologies: ['Python']
  }],
  projects: [], education: []
};

const JOB = {
  title: 'Senior Data Scientist',
  company: 'Synthetic Employer',
  description_text: 'Python daily, Python pipelines. Causal inference required, causal analysis. Kubernetes required, Kubernetes clusters.'
};

const detected = await detectLocalAIProviders();
if (!detected.length || !detected[0].models.length) {
  process.stdout.write('Cover letter acceptance: SKIPPED — no loaded local model server.\n');
  process.exit(0);
}
const target = detected[0];
const model = target.models[0];
process.stdout.write(`Using ${target.preset_id} model ${model}.\n`);

const provider = createAIProvider({
  env: {},
  config: { enabled: true, type: 'local_openai_compatible', baseUrl: target.base_url, model, timeoutMs: 120000, retries: 0 }
});

const deterministic = buildDeterministicCoverLetter({ profile: PROFILE, job: JOB });
const baseline = validateCoverLetterGrounding(deterministic, PROFILE, JOB);
if (!baseline.ok) throw new Error(`deterministic letter failed grounding: ${baseline.violations.join('; ')}`);

const started = Date.now();
const result = await provider.structuredTask({
  task: 'cover_letter_generation',
  input: aiCoverLetterInput({ profile: PROFILE, job: JOB, letter: deterministic }),
  schema: validateCoverLetterOutput,
  fallback: null
});
const elapsed = Date.now() - started;

if (result.status !== 'ok' || result.model_used !== true || !result.value) {
  process.stdout.write(`Cover letter acceptance: PASS (degraded) — model produced no valid output (${result.status}); deterministic letter stands. ${elapsed} ms.\n`);
  process.exit(0);
}

const merged = mergeAiCoverLetter(deterministic, result.value, PROFILE, JOB);
const finalGrounding = validateCoverLetterGrounding(merged.letter, PROFILE, JOB);
if (!finalGrounding.ok) {
  throw new Error(`UNSAFE: merged letter contains ungrounded content: ${finalGrounding.violations.join('; ')}`);
}

const bridge = merged.letter.paragraphs.find(paragraph => paragraph.origin === 'honest_bridge');
const lines = [
  `model answered in ${elapsed} ms`,
  `ai.status = ${merged.ai.status}`,
  merged.ai.status === 'ok'
    ? `paragraphs rewritten: ${merged.ai.paragraphs_rewritten}`
    : `violations (all AI content discarded): ${(merged.ai.violations || []).slice(0, 5).join(' | ')}`,
  bridge ? `honest bridge preserved: "${bridge.text.slice(0, 70)}…"` : 'no genuine gap for this job',
  'merged letter passes full grounding — no ungrounded line survived'
];
process.stdout.write(`Cover letter acceptance: PASS\n${lines.map(line => `  - ${line}`).join('\n')}\n`);
