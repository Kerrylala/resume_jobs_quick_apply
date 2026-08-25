import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHybridMatchResult,
  canonicalMatchScores,
  deterministicSemanticFallback,
  validateSemanticMatch
} from '../scripts/lib/hybrid_matching.mjs';

test('hybrid matching blends semantic evidence without changing deterministic state', () => {
  const result = buildHybridMatchResult({
    match_score: 80,
    hard_filter: { passed: true },
    approval_status: 'pending'
  }, {
    score: 90,
    recommendation: 'Apply',
    strengths: ['Transferable product delivery'],
    weaknesses: ['Limited sector experience'],
    missing: ['Sector terminology'],
    career_reason: 'Builds on verified technical and customer-facing experience.',
    confidence: 0.8
  }, { provider: 'mock', model: 'fixture', modelUsed: true, now: '2026-08-09T00:00:00.000Z' });
  assert.equal(result.score, 83);
  assert.equal(result.deterministic.score, 80);
  assert.equal(result.recommendation, 'Apply');
  assert.equal(result.safety.deterministic_score_changed, false);
  assert.equal(result.semantic.model_used, true);
  assert.match(result.immediate_fit, /80% deterministic fit/);
  assert.equal(result.career_growth_value, 'Builds on verified technical and customer-facing experience.');
  assert.deepEqual(result.skill_gaps, ['Limited sector experience', 'Sector terminology']);
  assert.equal(result.recommended_action, 'Apply');
});

test('a failed deterministic hard filter cannot be promoted by AI', () => {
  const result = buildHybridMatchResult({ match_score: 70, hard_filter: { passed: false } }, {
    score: 99,
    recommendation: 'Apply',
    strengths: ['Synthetic'], weaknesses: [], missing: [], career_reason: 'Synthetic', confidence: 1
  }, { modelUsed: true });
  assert.equal(result.recommendation, 'Do not apply');
  assert.equal(result.recommended_action, 'Do not apply');
  assert.ok(result.score <= 49);
  assert.equal(result.safety.blocked_job_promoted, false);
});

test('canonical score contract labels hybrid vs deterministic and never fabricates semantic values', () => {
  const semantic = {
    score: 90, recommendation: 'Apply', strengths: ['Synthetic'], weaknesses: [], missing: [],
    career_reason: 'Synthetic', confidence: 0.8
  };
  const aiJob = {
    match_score: 80,
    hybrid_match: buildHybridMatchResult({ match_score: 80, hard_filter: { passed: true } }, semantic, { modelUsed: true })
  };
  const aiScores = canonicalMatchScores(aiJob);
  assert.equal(aiScores.score_method, 'hybrid');
  assert.equal(aiScores.ai_used, true);
  assert.equal(aiScores.deterministic_score, 80);
  assert.equal(aiScores.semantic_score, 90);
  assert.equal(aiScores.combined_score, 83);
  assert.equal(aiScores.confidence, 0.8);

  const offlineJob = {
    match_score: 80,
    hybrid_match: buildHybridMatchResult({ match_score: 80, hard_filter: { passed: true } }, {}, { modelUsed: false })
  };
  const offlineScores = canonicalMatchScores(offlineJob);
  assert.equal(offlineScores.score_method, 'deterministic');
  assert.equal(offlineScores.ai_used, false);
  assert.equal(offlineScores.semantic_score, null);
  assert.equal(offlineScores.confidence, null);
  assert.equal(offlineScores.combined_score, 80);

  const unenriched = canonicalMatchScores({ match_score: 76 });
  assert.equal(unenriched.score_method, 'deterministic');
  assert.equal(unenriched.combined_score, 76);
  assert.equal(unenriched.semantic_score, null);

  // Scores stay comparable across jobs regardless of AI availability: the
  // canonical sort key is always combined_score on the same 0-100 scale.
  const sorted = [aiJob, offlineJob, { match_score: 76 }]
    .map(job => canonicalMatchScores(job).combined_score)
    .sort((a, b) => b - a);
  assert.deepEqual(sorted, [83, 80, 76]);
});

test('deterministic semantic fallback stays explainable when AI is disabled', () => {
  const fallback = deterministicSemanticFallback({ match_score: 62, strengths: ['SQL'], gaps: ['Cloud'] });
  assert.equal(fallback.recommendation, 'Consider');
  assert.deepEqual(fallback.strengths, ['SQL']);
  assert.deepEqual(fallback.weaknesses, ['Cloud']);
  assert.equal(validateSemanticMatch(fallback).ok, true);
});
