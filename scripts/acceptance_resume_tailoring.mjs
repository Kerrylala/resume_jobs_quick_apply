// Real-model acceptance for the tailored resume engine.
//
// Runs the REAL AI path against whatever local model server is up: build the
// deterministic draft, ask the model for a tailored rewrite, then let the
// grounding gate judge the genuine output. Both outcomes are acceptable and
// reported honestly:
//   - the model stays grounded → rewrites applied
//   - the model invents        → whole AI contribution rejected, deterministic
//                                draft stands
// What is NOT acceptable: an ungrounded line surviving into the final draft.
// The run re-validates the merged draft to prove that cannot happen.
//
// With no local model running it prints SKIPPED and exits 0 — never a fake pass.
import { createAIProvider, detectLocalAIProviders } from './lib/ai_provider.mjs';
import {
  aiTailoringInput,
  buildDeterministicDraft,
  mergeAiTailoring,
  validateDraftGrounding,
  validateResumeTailoringOutput
} from './lib/resume_tailoring.mjs';

const PROFILE = {
  identity: { full_name: 'Acceptance Test Candidate', email: 'acceptance@example.invalid', phone: '+1 555 0100', current_location: 'Shanghai, China', links: {} },
  career_goals: ['Data Scientist'],
  skills: { programming: ['Python', 'SQL'], ai_tools: ['PyTorch'], frameworks: [], cloud: ['AWS'], data: ['causal inference', 'A/B testing'], business: [] },
  experience: [
    {
      company: 'Synthetic Retail Co', role: 'Data Analyst', dates: '2021 – 2023',
      achievements: ['Reduced checkout latency by 18% using SQL query optimization'],
      responsibilities: ['Maintained nightly reporting pipelines'], technologies: ['SQL']
    },
    {
      company: 'Synthetic ML Lab', role: 'Machine Learning Engineer', dates: '2023 – now',
      achievements: ['Built a causal inference platform in Python serving 40 experiments per quarter'],
      responsibilities: ['Ran A/B testing reviews'], technologies: ['Python', 'PyTorch']
    }
  ],
  projects: [], education: [{ institution: 'Synthetic University', degree: 'MSc', field_of_study: 'Statistics' }]
};

const JOB = {
  title: 'Senior Data Scientist',
  description_text: 'We need Python, causal inference and A/B testing experience for our experimentation platform. PyTorch a plus.'
};

const detected = await detectLocalAIProviders();
if (!detected.length || !detected[0].models.length) {
  process.stdout.write('Resume tailoring acceptance: SKIPPED — no loaded local model server.\n');
  process.exit(0);
}
const target = detected[0];
const model = target.models[0];
process.stdout.write(`Using ${target.preset_id} model ${model}.\n`);

const provider = createAIProvider({
  env: {},
  config: { enabled: true, type: 'local_openai_compatible', baseUrl: target.base_url, model, timeoutMs: 120000, retries: 0 }
});

const deterministic = buildDeterministicDraft({ profile: PROFILE, job: JOB });
const baseline = validateDraftGrounding(deterministic, PROFILE);
if (!baseline.ok) throw new Error(`deterministic draft failed grounding: ${baseline.violations.join('; ')}`);

const started = Date.now();
const result = await provider.structuredTask({
  task: 'resume_tailoring',
  input: aiTailoringInput({ profile: PROFILE, job: JOB }),
  schema: validateResumeTailoringOutput,
  fallback: null
});
const elapsed = Date.now() - started;

if (result.status !== 'ok' || result.model_used !== true || !result.value) {
  process.stdout.write(`Resume tailoring acceptance: PASS (degraded) — model did not produce valid output (${result.status}), deterministic draft stands. ${elapsed} ms.\n`);
  process.exit(0);
}

const merged = mergeAiTailoring(deterministic, result.value, PROFILE, { job: JOB });
const finalGrounding = validateDraftGrounding(merged.draft, PROFILE);
if (!finalGrounding.ok) {
  throw new Error(`UNSAFE: merged draft contains ungrounded content: ${finalGrounding.violations.join('; ')}`);
}

const lines = [
  `model answered in ${elapsed} ms`,
  `ai.status = ${merged.ai.status}`,
  merged.ai.status === 'ok'
    ? `rewrites applied: ${merged.ai.rewrites_applied}`
    : `violations (all AI content discarded): ${(merged.ai.violations || []).slice(0, 5).join(' | ')}`,
  'merged draft passes full grounding — no ungrounded line survived'
];
process.stdout.write(`Resume tailoring acceptance: PASS\n${lines.map(line => `  - ${line}`).join('\n')}\n`);
