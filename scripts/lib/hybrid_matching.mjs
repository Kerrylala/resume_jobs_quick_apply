function text(value, max = 2000) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max);
}

function list(value, max = 20) {
  return Array.isArray(value) ? value.map(item => text(item)).filter(Boolean).slice(0, max) : [];
}

function clamp(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : minimum;
}

export function validateSemanticMatch(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const ok = Boolean(
    source
    && Number.isFinite(Number(source.score))
    && ['Apply', 'Consider', 'Do not apply'].includes(source.recommendation)
    && ['strengths', 'weaknesses', 'missing'].every(key => Array.isArray(source[key]))
    && typeof source.career_reason === 'string'
    && Number.isFinite(Number(source.confidence))
  );
  return { ok, errors: ok ? [] : ['Expected semantic job match fields and bounded numeric values.'] };
}

export function deterministicSemanticFallback(job = {}) {
  const deterministicScore = clamp(job.match_score, 0, 100);
  const strengths = list(job.strengths || job.score_breakdown?.matched_requirements);
  const weaknesses = list(job.weaknesses || job.gaps);
  const missing = list(job.missing || job.score_breakdown?.missing_requirements);
  const recommendation = job?.hard_filter?.passed === false
    ? 'Do not apply'
    : deterministicScore >= 75 ? 'Apply' : deterministicScore >= 55 ? 'Consider' : 'Do not apply';
  const careerReason = text(job.score_explanation || job.match_reason || 'Deterministic candidate and job evidence only.');
  return {
    score: deterministicScore,
    recommendation,
    strengths,
    weaknesses,
    missing,
    immediate_fit: job?.hard_filter?.passed === false
      ? 'Blocked by a required search constraint.'
      : `${Math.round(deterministicScore)}% deterministic fit${strengths.length ? `; strongest evidence: ${strengths.slice(0, 2).join(', ')}` : ''}.`,
    career_growth_value: careerReason,
    skill_gaps: [...new Set([...weaknesses, ...missing])].slice(0, 12),
    recommended_action: recommendation,
    career_reason: careerReason,
    confidence: 0
  };
}

// The one score contract every reader sorts and displays from. Two different
// methods (pure deterministic vs 70/30 AI blend) must never share one
// unlabeled number: combined_score is the canonical sort key, score_method
// says how it was produced, and semantic values are never fabricated when the
// AI was not actually used.
export function canonicalMatchScores(job = {}) {
  const hybrid = job?.hybrid_match && typeof job.hybrid_match === 'object' ? job.hybrid_match : null;
  const deterministicScore = clamp(hybrid?.deterministic?.score ?? job?.match_score ?? 0, 0, 100);
  const aiUsed = hybrid?.semantic?.model_used === true;
  return {
    deterministic_score: deterministicScore,
    semantic_score: aiUsed ? clamp(hybrid.semantic.score, 0, 100) : null,
    combined_score: hybrid ? clamp(hybrid.score, 0, 100) : deterministicScore,
    score_method: aiUsed ? 'hybrid' : 'deterministic',
    ai_used: aiUsed,
    confidence: aiUsed ? clamp(hybrid.confidence, 0, 1) : null
  };
}

export function buildHybridMatchResult(job = {}, semantic = {}, {
  provider = 'disabled',
  model = '',
  modelUsed = false,
  responseFormat = '',
  now = new Date().toISOString()
} = {}) {
  const deterministicScore = clamp(job.match_score, 0, 100);
  const fallback = deterministicSemanticFallback(job);
  const source = validateSemanticMatch(semantic).ok ? semantic : fallback;
  const semanticScore = clamp(source.score, 0, 100);
  const confidence = clamp(source.confidence, 0, 1);
  const hardFilterPassed = job?.hard_filter?.passed !== false && job?.score_breakdown?.hard_filter?.passed !== false;
  const blendedScore = modelUsed
    ? Math.round(deterministicScore * 0.7 + semanticScore * 0.3)
    : Math.round(deterministicScore);
  const recommendation = hardFilterPassed
    ? source.recommendation
    : 'Do not apply';
  const strengths = list(source.strengths);
  const weaknesses = list(source.weaknesses);
  const missing = list(source.missing);
  const careerReason = text(source.career_reason);
  return {
    schema_version: '1.0',
    score: hardFilterPassed ? blendedScore : Math.min(blendedScore, 49),
    recommendation,
    strengths,
    weaknesses,
    missing,
    immediate_fit: text(source.immediate_fit) || (hardFilterPassed
      ? `${Math.round(deterministicScore)}% deterministic fit${strengths.length ? `; strongest evidence: ${strengths.slice(0, 2).join(', ')}` : ''}.`
      : 'Blocked by a required search constraint.'),
    career_growth_value: text(source.career_growth_value) || careerReason,
    skill_gaps: list(source.skill_gaps).length
      ? list(source.skill_gaps)
      : [...new Set([...weaknesses, ...missing])].slice(0, 12),
    recommended_action: text(source.recommended_action) || recommendation,
    career_reason: careerReason,
    confidence,
    deterministic: {
      score: deterministicScore,
      hard_filter_passed: hardFilterPassed,
      remains_authoritative: true
    },
    semantic: {
      score: semanticScore,
      provider,
      model,
      model_used: modelUsed,
      response_format: responseFormat
    },
    evaluated_at: now,
    safety: {
      approval_changed: false,
      deterministic_score_changed: false,
      blocked_job_promoted: false
    }
  };
}
