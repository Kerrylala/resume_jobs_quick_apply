// Cover letters, grounded in the approved online Career Profile.
//
// Same architecture as the tailored resume: a deterministic letter assembled
// from confirmed facts (works with no AI), an optional AI rewrite that is
// re-validated line by line and rejected in full on any fabrication, and
// fact_refs provenance on every claim-bearing paragraph.
//
// Two design points absorbed from studying mature tooling in this space:
//   - HONEST BRIDGE: when the posting asks for something the profile
//     genuinely lacks, the letter names the gap plainly instead of hiding it
//     or padding around it. The bridge sentence carries only the gap keyword —
//     zero capability claims.
//   - NO MATCH COMMENTARY: the letter never embeds job-match analysis. The
//     previous template pasted `career_growth_value` verdicts straight into
//     the letter body — including negative ones ("it may not provide the same
//     long-term trajectory…"). A letter that argues against its own applicant
//     is a defect class this module makes structurally impossible: match
//     fields are never read.

import {
  buildKeywordCoverage,
  factText,
  groundingViolationsFor,
  refWithinOffered,
  resolveFactRef,
  tokenize
} from './resume_tailoring.mjs';

function text(value, limit = 2000) {
  return String(value ?? '').trim().slice(0, limit);
}

// --- Deterministic letter --------------------------------------------------

export function buildDeterministicCoverLetter({ profile = {}, job = {} } = {}) {
  const company = text(job.company, 300) || 'your team';
  const title = text(job.title, 300) || 'this role';

  // Coverage against an EMPTY draft partitions the posting's keywords into
  // "the profile supports this" (strength pool, with proving fact_refs) and
  // "the profile genuinely lacks this" (bridge pool).
  const coverage = buildKeywordCoverage({ profile, job, draft: { blocks: [] } });
  const strengths = coverage.missing_have_it.slice(0, 4);
  // Recurring description demands make honest bridges; title words are mostly
  // role naming and rank last.
  const gaps = coverage.missing_gap.filter(entry => !entry.from_title).concat(
    coverage.missing_gap.filter(entry => entry.from_title)
  );

  const paragraphs = [];

  // 1. Opening — identity of the job, not claims about the candidate.
  paragraphs.push({
    origin: 'job_scaffold',
    text: `Dear ${company} Hiring Team,`
  });
  paragraphs.push({
    origin: 'job_scaffold',
    text: `I am applying for the ${title} position.`
  });

  // 2. Fit — assembled from confirmed values only.
  const fitValues = [];
  if (text(profile.career_goals?.[0])) {
    fitValues.push({ text: text(profile.career_goals[0], 300), fact_refs: ['career_goals[0]'] });
  }
  for (const strength of strengths) {
    // Cite the first supporting fact; the keyword itself came from the posting.
    fitValues.push({ text: strength.keyword, fact_refs: strength.fact_refs.slice(0, 1) });
  }
  if (fitValues.length) {
    const goal = fitValues.find(value => value.fact_refs[0] === 'career_goals[0]');
    const keywordList = fitValues.filter(value => value !== goal).map(value => value.text);
    const rendered = [
      goal ? `My background is in ${goal.text}.` : '',
      keywordList.length ? `The requirements of this role match my confirmed experience with ${keywordList.join(', ')}.` : ''
    ].filter(Boolean).join(' ');
    paragraphs.push({
      origin: 'assembled',
      text: rendered,
      values: fitValues,
      fact_refs: fitValues.flatMap(value => value.fact_refs)
    });
  }

  // 3. Evidence — the two most job-relevant achievements, quoted verbatim.
  // Project descriptions count: for an early-career profile they are usually
  // the strongest material the letter has.
  for (const evidence of pickStrongestAchievements(profile, job, 2)) {
    paragraphs.push({
      origin: 'verbatim',
      text: evidence.text,
      fact_refs: [evidence.ref]
    });
  }

  // 4. Education — confirmed degree facts, assembled with provenance.
  const educationEntry = (Array.isArray(profile.education) ? profile.education : [])[0];
  if (educationEntry) {
    const degreeText = text(educationEntry.degree, 200);
    const fieldText = text(educationEntry.field_of_study, 200);
    const parts = [
      // "Bachelor in Bachelor of Science: …" — when the field already names
      // the degree, the degree word is duplication, not information.
      { text: degreeText && fieldText.toLowerCase().includes(degreeText.toLowerCase()) ? '' : degreeText, label: 'degree' },
      { text: fieldText, label: 'field' },
      { text: text(educationEntry.institution, 300), label: 'institution' },
      { text: text(educationEntry.end_date, 100), label: 'end_date' }
    ].filter(part => part.text);
    if (parts.length) {
      const pick = label => parts.find(part => part.label === label)?.text || '';
      const degreePart = pick('degree');
      const fieldPart = pick('field');
      const segments = [];
      if (degreePart && fieldPart) segments.push(`${degreePart} in ${fieldPart}`);
      else if (degreePart || fieldPart) segments.push(degreePart || fieldPart);
      if (pick('institution')) segments.push(segments.length ? `from ${pick('institution')}` : pick('institution'));
      if (pick('end_date')) segments.push(`(${pick('end_date')})`);
      paragraphs.push({
        origin: 'assembled',
        text: `My education includes ${segments.join(' ')}.`,
        values: parts.map(part => ({ text: part.text, fact_refs: ['education[0]'] })),
        fact_refs: ['education[0]']
      });
    }
  }

  // 5. Honest bridge — one genuine gap, named plainly, no claims attached.
  // The gap must be a phrase a human would recognize: "full stack", never the
  // shredded fragment "full" that a single-token gap list produces.
  const bridgeGap = pickBridgeGap(gaps, job);
  if (bridgeGap) {
    paragraphs.push({
      origin: 'honest_bridge',
      gap_keyword: bridgeGap,
      text: `I have not worked with ${bridgeGap} yet, and I would welcome the chance to close that gap quickly.`
    });
  }

  // 5. Closing — scaffold plus the confirmed name. `role` marks it for the
  // AI-merge partition: matching on the "Thank you" text prefix double-counted
  // a name-less closing as both scaffold and closing.
  const fullName = text(profile.identity?.full_name, 200);
  paragraphs.push({
    origin: fullName ? 'assembled' : 'job_scaffold',
    role: 'closing',
    text: fullName ? `Thank you for your consideration.\n\n${fullName}` : 'Thank you for your consideration.',
    ...(fullName ? { values: [{ text: fullName, fact_refs: ['identity.full_name'] }], fact_refs: ['identity.full_name'] } : {})
  });

  return {
    schema_version: '1.0',
    paragraphs,
    strengths_used: strengths.map(entry => entry.keyword),
    honest_gap: bridgeGap || '',
    provenance_complete: true
  };
}

function pickStrongestAchievements(profile, job, count = 2) {
  const signals = new Set(tokenize([job.title, job.description_text].join(' ')));
  const candidates = [];
  const consider = (value, ref) => {
    const bulletText = text(value, 600);
    if (!bulletText) return;
    let hits = 0;
    for (const token of new Set(tokenize(bulletText))) if (signals.has(token)) hits += 1;
    candidates.push({ text: bulletText, ref, hits });
  };
  (profile.experience || []).forEach((entry, index) => {
    (entry.achievements || []).forEach((bullet, bulletIndex) =>
      consider(bullet, `experience[${index}].achievements[${bulletIndex}]`));
  });
  (profile.projects || []).forEach((entry, index) => {
    consider(entry.description, `projects[${index}].description`);
    (entry.results || []).forEach((result, resultIndex) =>
      consider(result, `projects[${index}].results[${resultIndex}]`));
  });
  candidates.sort((left, right) => right.hits - left.hits);
  return candidates.slice(0, count);
}

// Single tokens that only mean something as part of a compound ("full stack",
// "front end"). A bridge naming one of these alone reads as a parser bug,
// which it is.
const GENERIC_GAP_FRAGMENTS = new Set([
  'full', 'stack', 'front', 'back', 'end', 'senior', 'junior', 'staff',
  'lead', 'level', 'strong', 'plus', 'team', 'years', 'new', 'hands'
]);

// Choose the gap the bridge names. Coverage produces single tokens; this
// reassembles the phrase as the posting wrote it by extending over ADJACENT
// tokens that are themselves gaps (capped at 3 words), then refuses any
// remaining bare fragment.
function pickBridgeGap(gaps, job) {
  if (!gaps.length) return '';
  const gapSet = new Set(gaps.map(entry => entry.keyword));
  const stream = tokenize([job.title, job.description_text].join(' '));
  for (const gap of gaps) {
    const keyword = gap.keyword;
    let phrase = keyword;
    const at = stream.indexOf(keyword);
    if (at !== -1) {
      let lo = at;
      let hi = at;
      while (hi < stream.length - 1 && hi - lo < 2 && gapSet.has(stream[hi + 1])) hi += 1;
      while (lo > 0 && hi - lo < 2 && gapSet.has(stream[lo - 1])) lo -= 1;
      phrase = stream.slice(lo, hi + 1).join(' ');
    }
    // The bridge validator refuses digits in the bridge text, so a gap like
    // "python3" must be skipped, not returned — returning it made the whole
    // deterministic letter fail its own validation.
    if (/\d/.test(phrase)) continue;
    if (phrase.includes(' ') || !GENERIC_GAP_FRAGMENTS.has(phrase)) return phrase;
  }
  return '';
}

// --- Grounding -------------------------------------------------------------

export function validateCoverLetterGrounding(letter, profile, job) {
  const violations = [];
  const jobText = tokenize([job?.company, job?.title].join(' ')).join(' ');

  (Array.isArray(letter?.paragraphs) ? letter.paragraphs : []).forEach((paragraph, index) => {
    const where = `paragraph[${index}]`;
    if (paragraph.origin === 'job_scaffold') {
      // May reference the job's own identity, never the candidate's abilities.
      return;
    }
    if (paragraph.origin === 'honest_bridge') {
      // The bridge must contain no numbers and no claims — only the fixed
      // scaffold plus the gap keyword.
      if (/\d/.test(paragraph.text)) violations.push(`${where}: bridge_contains_number`);
      if (!paragraph.gap_keyword || !paragraph.text.includes(paragraph.gap_keyword)) {
        violations.push(`${where}: bridge_missing_gap_keyword`);
      }
      return;
    }
    if (paragraph.origin === 'ai_rewritten') {
      // Same two-tier policy the merge applies — numbers strict to cited
      // facts, words honest against the confirmed inventory + job identity.
      for (const violation of aiParagraphViolations(paragraph, profile, job)) {
        violations.push(`${where}: ${violation}`);
      }
      return;
    }
    for (const violation of groundingViolationsFor(paragraph, profile)) {
      violations.push(`${where}: ${violation}`);
    }
  });

  // Structural honesty: match commentary must not exist in any text this
  // engine or an AI composed. Verbatim paragraphs are exempt — they quote the
  // user's own confirmed achievements, which may legitimately contain words
  // like "weakness" ("identified weakness patterns in authentication flows").
  const flat = (letter?.paragraphs || [])
    .filter(paragraph => paragraph.origin !== 'verbatim')
    .map(paragraph => paragraph.text).join(' ').toLowerCase();
  for (const marker of ['career trajectory', 'do not apply', 'may not provide', 'weakness', 'career_growth']) {
    if (flat.includes(marker)) violations.push(`letter_contains_match_commentary:${marker}`);
  }
  void jobText;

  return { ok: violations.length === 0, violations };
}

// --- AI merge --------------------------------------------------------------

export function aiCoverLetterInput({ profile = {}, job = {}, letter = {} } = {}) {
  const facts = [];
  const push = (ref) => {
    const value = resolveFactRef(profile, ref);
    const flat = text(factText(value), 400);
    if (flat) facts.push({ ref, text: flat });
  };
  push('career_goals[0]');
  (profile.experience || []).forEach((entry, index) => {
    // The whole entry too (role, employer, technologies) — a letter that gets
    // rejected for naming the candidate's own employer is misclassifying
    // confirmed facts as fabrication.
    push(`experience[${index}]`);
    (entry.achievements || []).forEach((bullet, bulletIndex) => push(`experience[${index}].achievements[${bulletIndex}]`));
  });
  // Projects and education are the strongest material an early-career profile
  // has; a letter engine that never shows them to the model writes thin
  // letters for exactly the people who need good ones.
  (profile.projects || []).forEach((entry, index) => push(`projects[${index}]`));
  (profile.education || []).forEach((entry, index) => push(`education[${index}]`));
  Object.entries(profile.skills || {}).forEach(([group, items]) => {
    (Array.isArray(items) ? items : []).forEach((skill, index) => push(`skills.${group}[${index}]`));
  });
  return {
    job: { title: text(job.title, 300), company: text(job.company, 300), description: text(job.description_text, 4000) },
    current_paragraphs: (letter.paragraphs || [])
      .filter(paragraph => ['assembled', 'verbatim'].includes(paragraph.origin))
      .map(paragraph => ({ text: paragraph.text, fact_refs: paragraph.fact_refs || [] })),
    facts: facts.slice(0, 120)
  };
}

// The floor a letter body must clear. One thin sentence is not a cover
// letter; validating length HERE means structuredTask retries (and finally
// falls back to the deterministic letter) instead of persisting a stub.
export const MIN_AI_BODY_WORDS = 90;

// tokenize() sees only Latin words; each CJK character counts as a word so a
// Chinese letter is not scored as an empty body.
function bodyWordCount(value) {
  const cjkCharacters = (String(value || '').match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu) || []).length;
  return tokenize(value).length + cjkCharacters;
}

export function validateCoverLetterOutput(value) {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'not_an_object' };
  if (!Array.isArray(value.paragraphs)) return { ok: false, reason: 'paragraphs_shape' };
  if (value.paragraphs.length < 2 || value.paragraphs.length > 4) {
    return { ok: false, reason: 'paragraph_count' };
  }
  for (const paragraph of value.paragraphs) {
    if (typeof paragraph?.text !== 'string' || !Array.isArray(paragraph?.fact_refs) || !paragraph.fact_refs.length) {
      return { ok: false, reason: 'paragraph_shape' };
    }
  }
  const bodyWords = value.paragraphs.reduce((total, paragraph) => total + bodyWordCount(paragraph.text), 0);
  if (bodyWords < MIN_AI_BODY_WORDS) return { ok: false, reason: 'body_too_short' };
  return { ok: true };
}

function jobIdentityText(job) {
  return text(`${job?.company || ''} ${job?.title || ''}`, 400).trim();
}

// Every word a paragraph may use beyond its cited facts while staying honest:
// the job's own identity plus the FULL user-confirmed fact inventory. Same
// enumeration the AI input uses, so contact details never become grounding.
function honestWordPool(profile, job) {
  return `${jobIdentityText(job)} ${aiCoverLetterInput({ profile, job }).facts.map(fact => fact.text).join(' ')}`.trim();
}

// AI paragraphs get a two-tier check. NUMBERS must come from the facts the
// paragraph CITES — a metric moved to a different employer is a false claim
// even when the number exists somewhere in the profile. WORDS only need to
// be honest: present in some user-confirmed fact or the job's identity. A
// project named beside an adjacent citation is a miscitation, not a
// fabrication — rejecting the whole letter for it made grounded models fail
// most of the time, which is how one-sentence letters shipped.
function aiParagraphViolations(paragraph, profile, job, wordPool) {
  const cited = groundingViolationsFor({ ...paragraph, extra_grounding: jobIdentityText(job) }, profile);
  const strict = cited.filter(violation =>
    violation.startsWith('number_not_in_facts')
    || violation.startsWith('missing_fact_refs')
    || violation.startsWith('unresolvable_ref'));
  const wide = groundingViolationsFor(
    { ...paragraph, extra_grounding: wordPool ?? honestWordPool(profile, job) },
    profile
  ).filter(violation => !violation.startsWith('number_not_in_facts'));
  const violations = [...strict, ...wide];
  // The job-identity allowance lets the letter NAME the target company; it
  // must not let it claim a history there. An employment verb next to the
  // company's name is a fabricated relationship — unless that company really
  // is one of the candidate's confirmed employers.
  const employers = new Set((Array.isArray(profile.experience) ? profile.experience : [])
    .flatMap(entry => tokenize(entry?.company || '')));
  const companyTokens = tokenize(job?.company || '')
    .filter(token => token.length >= 3 && !employers.has(token))
    .map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (companyTokens.length) {
    const employmentClaim = new RegExp(
      `\\b(?:worked|employed|interned)\\b[^.!?]{0,60}\\b(?:${companyTokens.join('|')})\\b`, 'iu');
    if (employmentClaim.test(paragraph.text)) violations.push('implied_employment_at_target_company');
  }
  return violations;
}

// All-or-nothing, same as the resume: one ungrounded paragraph rejects the
// entire AI contribution and the deterministic letter stands.
export function mergeAiCoverLetter(letter, aiResult, profile, job) {
  const shape = validateCoverLetterOutput(aiResult);
  if (!shape.ok) {
    return { letter, ai: { status: 'rejected_ungrounded', violations: [`output_shape:${shape.reason}`] } };
  }

  const violations = [];
  // The job's own identity words (title, company) are data from the posting,
  // not fabrication — a letter that cannot name the job it is for can only
  // write generic fact-parroting lines. Set by THIS code, never copied from
  // model output.
  const jobIdentity = jobIdentityText(job);
  const wordPool = honestWordPool(profile, job);
  const rewritten = aiResult.paragraphs.slice(0, 4).map(paragraph => ({
    origin: 'ai_rewritten',
    text: text(paragraph.text, 1200),
    fact_refs: paragraph.fact_refs,
    ...(jobIdentity ? { extra_grounding: jobIdentity } : {})
  }));
  // Model-supplied refs must come from the inventory the model was shown —
  // resolveFactRef would happily resolve identity/contact paths the input
  // deliberately withheld, laundering the candidate's phone digits into the
  // grounding source.
  const offeredRefs = new Set(aiCoverLetterInput({ profile, job }).facts.map(fact => fact.ref));
  rewritten.forEach((paragraph, index) => {
    for (const ref of Array.isArray(paragraph.fact_refs) ? paragraph.fact_refs : []) {
      if (!refWithinOffered(ref, offeredRefs)) violations.push(`ai.paragraph[${index}]: ref_not_offered:${ref}`);
    }
  });
  rewritten.forEach((paragraph, index) => {
    for (const violation of aiParagraphViolations(paragraph, profile, job, wordPool)) {
      violations.push(`ai.paragraph[${index}]: ${violation}`);
    }
  });
  if (violations.length) {
    return { letter, ai: { status: 'rejected_ungrounded', violations: violations.slice(0, 20) } };
  }

  // Grounded but thin is still a failed letter: if the AI body carries fewer
  // words than the deterministic body it would replace (or under the absolute
  // floor), keep the deterministic letter. Quality problem, not a trust
  // problem — no rejection, just no downgrade.
  const wordCount = paragraphs => paragraphs.reduce((total, paragraph) => total + bodyWordCount(paragraph.text), 0);
  const deterministicBodyWords = wordCount(letter.paragraphs.filter(paragraph => ['assembled', 'verbatim'].includes(paragraph.origin)));
  const aiBodyWords = wordCount(rewritten);
  const floor = Math.max(MIN_AI_BODY_WORDS, Math.round(deterministicBodyWords * 0.8));
  if (aiBodyWords < floor) {
    return { letter, ai: { status: 'fallback_thin_output', body_words: aiBodyWords, floor } };
  }

  // Replace the claim-bearing middle; keep scaffold opening, honest bridge and
  // closing exactly as the deterministic letter wrote them.
  const merged = structuredClone(letter);
  // The closing is identified by its role tag, never by text prefix — a
  // name-less closing carries origin job_scaffold, and prefix matching put it
  // in BOTH the scaffold and closing buckets, duplicating it around the body.
  const opening = merged.paragraphs.filter(paragraph => paragraph.origin === 'job_scaffold' && paragraph.text.startsWith('Dear'));
  const applying = merged.paragraphs.filter(paragraph =>
    paragraph.origin === 'job_scaffold' && !paragraph.text.startsWith('Dear') && paragraph.role !== 'closing');
  const bridge = merged.paragraphs.filter(paragraph => paragraph.origin === 'honest_bridge');
  const closing = merged.paragraphs.filter(paragraph => paragraph.role === 'closing');
  merged.paragraphs = [...opening, ...applying, ...rewritten, ...bridge, ...closing];

  const grounding = validateCoverLetterGrounding(merged, profile, job);
  if (!grounding.ok) {
    return { letter, ai: { status: 'rejected_ungrounded', violations: grounding.violations.slice(0, 20) } };
  }
  return { letter: merged, ai: { status: 'ok', paragraphs_rewritten: rewritten.length } };
}
