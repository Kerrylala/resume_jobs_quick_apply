// Tailored resume drafts, grounded in the approved online Career Profile.
//
// The whole design serves one rule: a tailored resume may SELECT, REORDER and
// REWORD confirmed facts, and may never invent one. That rule is enforced in
// code, not in a prompt:
//
//   - The deterministic path assembles blocks whose text is taken verbatim
//     from profile facts (plus a handful of fixed scaffold phrases), so it is
//     grounded by construction and works with no AI at all.
//   - The AI path may only contribute a rewritten summary and reworded copies
//     of individual bullets, each carrying the fact_refs it came from.
//     validateDraftGrounding re-checks every AI line against the referenced
//     facts — unresolvable refs, unknown numbers, or unknown proper nouns
//     reject the ENTIRE AI contribution, falling back to the deterministic
//     draft. A partially-trustworthy resume is not a thing.
//
// Every item keeps `fact_refs` (paths like "experience[0].achievements[1]"),
// so any line in the final document is traceable to the confirmed facts it
// came from.

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  'you', 'your', 'our', 'their', 'has', 'have', 'had', 'will', 'would',
  'can', 'could', 'should', 'about', 'into', 'over', 'under', 'between',
  'per', 'via', 'able', 'who', 'what', 'when', 'where', 'how', 'why',
  'of', 'in', 'on', 'at', 'to', 'as', 'by', 'or', 'an', 'be', 'is', 'it',
  'we', 'us', 'they', 'them', 'not', 'but', 'if', 'than', 'then', 'its',
  'work', 'working', 'team', 'teams', 'role', 'job', 'company', 'position',
  'experience', 'years', 'strong', 'excellent', 'skills', 'ability',
  'responsibilities', 'requirements', 'preferred', 'required', 'plus',
  'including', 'etc', 'more', 'other', 'new', 'help', 'build', 'building'
]);

// Scaffold phrases the deterministic assembler may use around fact values.
// Grounding treats these as neutral; anything else must come from facts.
const TEMPLATE_PHRASES = [
  'target role', 'key strengths', 'core skills', 'summary', 'currently at'
];

function text(value, limit = 4000) {
  return String(value ?? '').trim().slice(0, limit);
}

export function tokenize(value) {
  return (String(value || '')
    .toLowerCase()
    .match(/[a-z0-9+#.]{2,}/g) || [])
    // The dot belongs inside tokens like "node.js"; a sentence-final dot does
    // not. Without this, "required." slips past the "required" stopword and
    // becomes a phantom keyword.
    .map(token => token.replace(/^\.+|\.+$/g, ''))
    .filter(token => token.length >= 2);
}

function contentTokens(value) {
  return tokenize(value).filter(token => token.length >= 3 && !STOPWORDS.has(token));
}

// Full-width digits (５０％) are the same claim as 50% — normalize before any
// number check so a CJK-locale model cannot write a metric the detector
// cannot see.
function normalizeDigits(value) {
  return String(value || '')
    .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0))
    .replace(/％/g, '%');
}

function numbersIn(value) {
  // 3, 3.5, 35%, 1,200 — the shapes a fabricated metric would take.
  return (normalizeDigits(value).match(/\d[\d,.]*%?/g) || [])
    .map(item => item.replace(/[.,]$/, ''));
}

// "2018" must never ground a claimed "20": a number matches the source only
// when it appears there as a WHOLE number, not as a substring of a longer
// one. ("125" quoted from a fact's "125%" still passes.)
function numberAppearsWhole(number, source) {
  const escaped = number.replace(/%$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.,])${escaped}(?!\\d|[.,]\\d)`).test(normalizeDigits(source));
}

// Words that look like proper nouns (companies, products, institutions). The
// first word of a sentence is exempt: rewording legitimately changes it.
function properNounTokens(value) {
  const words = String(value || '').split(/\s+/);
  const found = [];
  let sentenceStart = true;
  for (const raw of words) {
    const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (!word) continue;
    if (!sentenceStart) {
      if (/^[A-Z][a-zA-Z0-9]+$/.test(word)) found.push(word.toLowerCase());
      // "AT&T", "O'Reilly": capitalized names with internal punctuation never
      // match the plain pattern, which made them invisible to the check.
      else if (/^[A-Z]/.test(word) && /[^A-Za-z0-9]/.test(word) && /[A-Za-z]{2}/.test(word)) {
        found.push(word.toLowerCase());
      }
    }
    sentenceStart = /[.!?:;]\s*$/.test(raw);
  }
  return found;
}

// --- Fact reference resolution -------------------------------------------

// Resolves "experience[0].achievements[1]" against a profile object.
export function resolveFactRef(profile, ref) {
  const segments = String(ref || '')
    .split('.')
    .flatMap(segment => {
      const parts = [];
      const match = segment.match(/^([a-z_]+)((?:\[\d+\])*)$/i);
      if (!match) return [Symbol('invalid')];
      parts.push(match[1]);
      for (const index of match[2].matchAll(/\[(\d+)\]/g)) parts.push(Number(index[1]));
      return parts;
    });
  let current = profile;
  for (const segment of segments) {
    if (typeof segment === 'symbol') return undefined;
    if (current === null || typeof current !== 'object') return undefined;
    // Own properties only: a ref like "constructor.prototype" must resolve to
    // nothing, not walk the prototype chain.
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

// The searchable text of whatever a fact ref resolves to.
export function factText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(factText).join(' ');
  if (typeof value === 'object') return Object.values(value).map(factText).join(' ');
  return '';
}

// --- Job signals ----------------------------------------------------------

export function extractJobSignals(job = {}) {
  const source = [text(job.title, 300), text(job.description_text, 20000)].join(' ');
  return new Set(contentTokens(source));
}

function relevanceOf(value, signals) {
  let hits = 0;
  for (const token of new Set(contentTokens(value))) {
    if (signals.has(token)) hits += 1;
  }
  return hits;
}

// --- Deterministic draft --------------------------------------------------

function verbatimItem(textValue, refs, relevance = 0) {
  return { origin: 'verbatim', text: text(textValue), fact_refs: refs, relevance };
}

// Jaccard similarity over content tokens — how close two bullets are.
function bulletSimilarity(left, right) {
  const a = new Set(contentTokens(left));
  const b = new Set(contentTokens(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// Line-cutting inspired by relevance-weighted CV trimming: a bullet's keep
// score is (relevance to THIS job) + (narrative load: quantified achievements
// are the resume's spine) − (duplication of something already kept). The
// lowest scores are cut first — never "the oldest role" mechanically — and
// every cut line is recorded with its fact_refs so it is one click to restore.
function applyBulletBudget(entryLists, { perEntry, total }, cutLines) {
  const keptAll = [];
  for (const entry of entryLists) {
    const scored = entry.bullets.map(bullet => ({
      bullet,
      score: bullet.relevance
        + (numbersIn(bullet.text).length ? 1.5 : 0)
    })).sort((left, right) => right.score - left.score);

    const kept = [];
    for (const candidate of scored) {
      const duplicateOf = keptAll.find(existing => bulletSimilarity(existing.text, candidate.bullet.text) > 0.6);
      if (duplicateOf) {
        cutLines.push({
          text: candidate.bullet.text,
          fact_refs: candidate.bullet.fact_refs,
          reason: 'duplicate',
          similar_to: duplicateOf.fact_refs[0]
        });
        continue;
      }
      if (kept.length >= perEntry) {
        cutLines.push({ text: candidate.bullet.text, fact_refs: candidate.bullet.fact_refs, reason: 'over_entry_budget' });
        continue;
      }
      kept.push(candidate.bullet);
      keptAll.push(candidate.bullet);
    }
    entry.bullets = kept;
  }
  // Global budget: trim the weakest kept bullets across all entries.
  while (keptAll.length > total) {
    let weakest = null;
    for (const entry of entryLists) {
      for (const bullet of entry.bullets) {
        const score = bullet.relevance + (numbersIn(bullet.text).length ? 1.5 : 0);
        if (!weakest || score < weakest.score) weakest = { entry, bullet, score };
      }
    }
    if (!weakest) break;
    weakest.entry.bullets = weakest.entry.bullets.filter(bullet => bullet !== weakest.bullet);
    keptAll.splice(keptAll.indexOf(weakest.bullet), 1);
    cutLines.push({ text: weakest.bullet.text, fact_refs: weakest.bullet.fact_refs, reason: 'over_total_budget' });
  }
}

export function buildDeterministicDraft({ profile = {}, job = {}, options = {} } = {}) {
  const budget = {
    perEntry: Math.max(1, Number(options.bullet_budget?.per_entry) || 4),
    total: Math.max(2, Number(options.bullet_budget?.total) || 24)
  };
  const cutLines = [];
  const signals = extractJobSignals(job);
  const blocks = [];
  const identity = profile.identity || {};

  // Header: contact identity, verbatim.
  const headerItems = [];
  const headerFields = [
    ['full_name', 'identity.full_name'],
    ['email', 'identity.email'],
    ['phone', 'identity.phone'],
    ['current_location', 'identity.current_location']
  ];
  for (const [key, ref] of headerFields) {
    if (text(identity[key])) headerItems.push(verbatimItem(identity[key], [ref]));
  }
  for (const linkKey of ['linkedin', 'github', 'portfolio']) {
    const value = identity.links?.[linkKey];
    if (text(value)) headerItems.push(verbatimItem(value, [`identity.links.${linkKey}`]));
  }
  if (headerItems.length) blocks.push({ kind: 'header', items: headerItems });

  // Summary: assembled from confirmed values only. The scaffold is fixed; the
  // values each carry their own provenance.
  const summaryValues = [];
  if (text(profile.career_goals?.[0])) {
    summaryValues.push({ text: text(profile.career_goals[0]), fact_refs: ['career_goals[0]'] });
  }
  const skillGroups = profile.skills || {};
  const matchedSkills = [];
  for (const [group, items] of Object.entries(skillGroups)) {
    (Array.isArray(items) ? items : []).forEach((skill, index) => {
      const relevance = relevanceOf(skill, signals);
      if (relevance > 0) matchedSkills.push({ skill: text(skill), ref: `skills.${group}[${index}]`, relevance });
    });
  }
  matchedSkills.sort((left, right) => right.relevance - left.relevance);
  for (const match of matchedSkills.slice(0, 4)) {
    summaryValues.push({ text: match.skill, fact_refs: [match.ref] });
  }
  {
    const goal = text(profile.career_goals?.[0]);
    const jobTitle = text(job.title, 300);
    const skillList = summaryValues.filter(value => value.fact_refs[0].startsWith('skills.')).map(value => value.text);
    // The summary names THE JOB even without AI: the title is data from the
    // posting (extra_grounding widens exactly by these words), so the
    // fallback a rejected AI result lands on is still visibly job-targeted.
    const rendered = [
      jobTitle ? `Candidate for ${jobTitle}.` : '',
      goal ? `Target role: ${goal}.` : '',
      skillList.length ? `Key strengths: ${skillList.join(', ')}.` : ''
    ].filter(Boolean).join(' ');
    if (summaryValues.length && rendered) {
      blocks.push({
        kind: 'summary',
        items: [{
          origin: 'assembled',
          text: rendered,
          values: summaryValues,
          fact_refs: summaryValues.flatMap(value => value.fact_refs),
          ...(jobTitle ? { extra_grounding: jobTitle } : {})
        }]
      });
    } else if (jobTitle) {
      // No goal and no matching skills — the summary still EXISTS and still
      // names the job. Pure posting words, zero candidate claims: origin
      // job_scaffold, the same allowance the cover letter's opening has.
      blocks.push({
        kind: 'summary',
        items: [{
          origin: 'job_scaffold',
          text: `Candidate for ${jobTitle}.`,
          extra_grounding: jobTitle
        }]
      });
    }
  }

  // Skills: every confirmed skill, job-matched ones first inside each group.
  const skillItems = [];
  for (const [group, items] of Object.entries(skillGroups)) {
    const entries = (Array.isArray(items) ? items : []).map((skill, index) => ({
      origin: 'verbatim',
      text: text(skill),
      fact_refs: [`skills.${group}[${index}]`],
      group,
      relevance: relevanceOf(skill, signals)
    })).filter(item => item.text);
    entries.sort((left, right) => right.relevance - left.relevance);
    skillItems.push(...entries);
  }
  // Spoken languages render as their own line — never mixed into a skills
  // group. Verbatim + fact_refs like every other item.
  (Array.isArray(profile.languages) ? profile.languages : []).forEach((language, index) => {
    // A language is stored as {id, name, proficiency} — only the human parts
    // may print; serializing the object leaked internal ids into the resume.
    const value = text([language?.name, language?.proficiency].filter(Boolean).join(' ')
      || (typeof language === 'string' ? language : ''));
    if (value) {
      skillItems.push({
        origin: 'verbatim',
        text: value,
        fact_refs: [`languages[${index}]`],
        group: 'languages',
        relevance: 0
      });
    }
  });
  if (skillItems.length) blocks.push({ kind: 'skills', items: skillItems });

  // Experience: entries ranked by how much they overlap the job, bullets
  // inside each entry ranked the same way. All text verbatim from facts.
  const experiences = (Array.isArray(profile.experience) ? profile.experience : [])
    .map((entry, index) => {
      const bulletSources = [
        ...(Array.isArray(entry.achievements) ? entry.achievements : []).map((bullet, bulletIndex) => ({
          text: text(bullet), ref: `experience[${index}].achievements[${bulletIndex}]`
        })),
        ...(Array.isArray(entry.responsibilities) ? entry.responsibilities : []).map((bullet, bulletIndex) => ({
          text: text(bullet), ref: `experience[${index}].responsibilities[${bulletIndex}]`
        }))
      ].filter(bullet => bullet.text);
      const bullets = bulletSources.map(bullet => verbatimItem(bullet.text, [bullet.ref], relevanceOf(bullet.text, signals)));
      bullets.sort((left, right) => right.relevance - left.relevance);
      const entryText = [entry.role, entry.company, factText(entry.technologies)].join(' ');
      return {
        company: text(entry.company),
        role: text(entry.role),
        dates: text(entry.dates || [entry.start_date, entry.end_date].filter(Boolean).join(' – ')),
        fact_refs: [`experience[${index}]`],
        relevance: relevanceOf(entryText, signals) + bullets.reduce((sum, bullet) => sum + bullet.relevance, 0),
        bullets
      };
    })
    // Keep every entry that carries CONTENT: a heading-less entry (imperfect
    // parse) still owns its bullets — dropping it deleted whole resumes.
    .filter(entry => entry.company || entry.role || entry.bullets.length);
  experiences.sort((left, right) => right.relevance - left.relevance);
  applyBulletBudget(experiences, budget, cutLines);
  if (experiences.length) blocks.push({ kind: 'experience', entries: experiences });

  // Projects: same treatment.
  const projects = (Array.isArray(profile.projects) ? profile.projects : [])
    .map((entry, index) => {
      const bullets = [
        entry.description ? verbatimItem(entry.description, [`projects[${index}].description`], relevanceOf(entry.description, signals)) : null,
        ...(Array.isArray(entry.results) ? entry.results : []).map((result, resultIndex) =>
          verbatimItem(result, [`projects[${index}].results[${resultIndex}]`], relevanceOf(result, signals)))
      ].filter(Boolean);
      return {
        name: text(entry.name),
        fact_refs: [`projects[${index}]`],
        relevance: relevanceOf([entry.name, factText(entry.technologies), entry.description].join(' '), signals),
        bullets
      };
    })
    .filter(entry => entry.name || entry.bullets.length);
  projects.sort((left, right) => right.relevance - left.relevance);
  if (projects.length) blocks.push({ kind: 'projects', entries: projects.slice(0, 6) });

  // Education: full history, chronological as stored, never trimmed — leaving
  // out a degree is a decision for the user, not the tailorer.
  const education = (Array.isArray(profile.education) ? profile.education : [])
    .map((entry, index) => ({
      institution: text(entry.institution),
      degree: text(entry.degree),
      field_of_study: text(entry.field_of_study),
      dates: text([entry.start_date, entry.end_date].filter(Boolean).join(' – ')),
      fact_refs: [`education[${index}]`]
    }))
    .filter(entry => entry.institution || entry.degree);
  if (education.length) blocks.push({ kind: 'education', entries: education });

  return {
    schema_version: '1.0',
    blocks,
    job_signals_matched: matchedSkills.length,
    cut_lines: cutLines,
    provenance_complete: true
  };
}

// --- Draft content coverage (completeness verifier) ------------------------

// Verifies the draft carries the profile's substance: every experience entry,
// every education entry, the project list (up to the renderer's cap) and the
// skill set. A draft that silently dropped entries is flagged — the UI shows
// "内容不完整" instead of pretending the file is ready.
export function verifyDraftCoverage(draft = {}, profile = {}) {
  const blocks = Array.isArray(draft.blocks) ? draft.blocks : [];
  const entriesOf = kind => blocks.filter(block => block.kind === kind)
    .flatMap(block => Array.isArray(block.entries) ? block.entries : []);
  const itemsOf = kind => blocks.filter(block => block.kind === kind)
    .flatMap(block => Array.isArray(block.items) ? block.items : []);

  // Count by CONTENT, never by the builder's eligibility predicates — sharing
  // the builder's filters made total loss verify as 0/0 = "complete".
  const profileExperience = (Array.isArray(profile.experience) ? profile.experience : [])
    .filter(entry => text(entry.company) || text(entry.role)
      || (Array.isArray(entry.responsibilities) && entry.responsibilities.some(item => text(item)))
      || (Array.isArray(entry.achievements) && entry.achievements.some(item => text(item))));
  const profileProjects = (Array.isArray(profile.projects) ? profile.projects : [])
    .filter(entry => text(entry.name) || text(entry.description)
      || (Array.isArray(entry.results) && entry.results.some(item => text(item))));
  const profileEducation = (Array.isArray(profile.education) ? profile.education : [])
    .filter(entry => text(entry.institution) || text(entry.degree));
  const profileSkills = Object.values(profile.skills || {})
    .flatMap(items => Array.isArray(items) ? items : [])
    .map(value => text(value)).filter(Boolean);

  const draftSkillTexts = new Set(itemsOf('skills').map(item => text(item.text)).filter(Boolean));
  const sections = {
    experience: { total: profileExperience.length, included: entriesOf('experience').length },
    projects: { total: profileProjects.length, included: entriesOf('projects').length, cap: 6 },
    education: { total: profileEducation.length, included: entriesOf('education').length },
    skills: { total: profileSkills.length, included: profileSkills.filter(skill => draftSkillTexts.has(skill)).length }
  };
  const warnings = [];
  if (sections.experience.included < sections.experience.total) {
    warnings.push(`experience: ${sections.experience.included}/${sections.experience.total} entries in the draft`);
  }
  if (sections.education.included < sections.education.total) {
    warnings.push(`education: ${sections.education.included}/${sections.education.total} entries in the draft`);
  }
  if (sections.projects.included < Math.min(sections.projects.total, sections.projects.cap)) {
    warnings.push(`projects: ${sections.projects.included}/${Math.min(sections.projects.total, sections.projects.cap)} entries in the draft`);
  }
  if (sections.skills.included < sections.skills.total) {
    warnings.push(`skills: ${sections.skills.included}/${sections.skills.total} skills in the draft`);
  }
  return {
    complete: warnings.length === 0,
    sections,
    cut_bullets: Array.isArray(draft.cut_lines) ? draft.cut_lines.length : 0,
    warnings
  };
}

// --- Keyword coverage (the deterministic reviewer) -------------------------

// Classifies every meaningful keyword of the posting three ways:
//   covered          — present in the draft
//   missing_have_it  — supported by a confirmed fact the draft did not use
//   missing_gap      — the profile genuinely does not have it
//
// The point of the third bucket is honesty: a genuine gap STAYS visible.
// Nothing anywhere uses this list to stuff wording into the draft; it exists
// so the user sees exactly what the job wants that they truly lack.
// Words that describe the posting, not a skill. Without this filter the gap
// report suggested bridging "senior" — and a letter saying "I have not worked
// with senior yet" is worse than no letter.
const NON_SKILL_WORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'intern', 'internship',
  'level', 'daily', 'weekly', 'monthly', 'yearly', 'quarterly', 'ongoing',
  'must', 'ideal', 'ideally', 'candidate', 'candidates', 'applicant',
  'bonus', 'nice', 'salary', 'benefits', 'remote', 'hybrid', 'onsite',
  'full-time', 'fulltime', 'part-time', 'parttime', 'contract',
  // Role nouns: naming the job is not naming a skill.
  'scientist', 'engineer', 'developer', 'manager', 'analyst', 'architect',
  'designer', 'specialist', 'consultant', 'director'
]);

export function buildKeywordCoverage({ profile = {}, job = {}, draft = {} } = {}) {
  const skillWord = token => !NON_SKILL_WORDS.has(token);
  const titleTokens = new Set(contentTokens(job.title).filter(skillWord));
  const descriptionTokens = contentTokens(job.description_text).filter(skillWord);
  const frequency = new Map();
  for (const token of descriptionTokens) frequency.set(token, (frequency.get(token) || 0) + 1);

  // Title words always count; description words need to recur to matter.
  const keywords = [...new Set([
    ...titleTokens,
    ...[...frequency.entries()].filter(([, count]) => count >= 2).map(([token]) => token)
  ])].slice(0, 60);

  const draftText = [];
  for (const block of Array.isArray(draft.blocks) ? draft.blocks : []) {
    for (const item of block.items || []) {
      // The summary's "Candidate for <job title>." line states INTENT, not
      // capability. Counting its words as covered would tell the reviewer a
      // gap keyword is "in the resume" when the profile does not have it.
      draftText.push(block.kind === 'summary'
        ? String(item.text || '').replace(/^Candidate for [^.]*\.\s*/, '')
        : item.text);
    }
    for (const entry of block.entries || []) {
      draftText.push(entry.company, entry.role, entry.name, entry.institution, entry.degree);
      for (const bullet of entry.bullets || []) draftText.push(bullet.text);
    }
  }
  const draftTokens = new Set(contentTokens(draftText.filter(Boolean).join(' ')));

  // The searchable, citable fact inventory — same enumeration the AI input
  // uses, so "have it" always comes with the refs that prove it.
  const facts = aiTailoringInput({ profile, job }).facts;

  const covered = [];
  const missingHaveIt = [];
  const missingGap = [];
  for (const keyword of keywords) {
    if (draftTokens.has(keyword)) {
      covered.push({ keyword, from_title: titleTokens.has(keyword) });
      continue;
    }
    const supporting = facts
      .filter(fact => new Set(contentTokens(fact.text)).has(keyword))
      .map(fact => fact.ref)
      .slice(0, 5);
    if (supporting.length) {
      missingHaveIt.push({ keyword, from_title: titleTokens.has(keyword), fact_refs: supporting });
    } else {
      missingGap.push({ keyword, from_title: titleTokens.has(keyword) });
    }
  }

  return {
    covered,
    missing_have_it: missingHaveIt,
    missing_gap: missingGap,
    coverage_ratio: keywords.length ? Number((covered.length / keywords.length).toFixed(2)) : 1
  };
}

// --- Grounding validation -------------------------------------------------

function groundingSourceFor(item, profile) {
  const refs = Array.isArray(item.fact_refs) ? item.fact_refs : [];
  if (!refs.length) return { ok: false, reason: 'missing_fact_refs', source: '' };
  const pieces = [];
  for (const ref of refs) {
    const resolved = resolveFactRef(profile, ref);
    if (resolved === undefined || resolved === null || factText(resolved).trim() === '') {
      return { ok: false, reason: `unresolvable_ref:${ref}`, source: '' };
    }
    pieces.push(factText(resolved));
  }
  return { ok: true, source: pieces.join(' ') };
}

function validateItemAgainstSource(item, source) {
  const violations = [];
  const sourceTokens = new Set(tokenize(source));
  const sourceNumbers = new Set(numbersIn(source));

  // Numbers are checked strictly: an invented metric is the most damaging
  // fabrication a resume can carry.
  for (const number of numbersIn(item.text)) {
    if (!sourceNumbers.has(number) && !numberAppearsWhole(number, source)) {
      violations.push(`number_not_in_facts:${number}`);
    }
  }

  if (item.origin === 'verbatim') {
    const normalizedSource = tokenize(source).join(' ');
    const normalizedText = tokenize(item.text).join(' ');
    if (normalizedText && !normalizedSource.includes(normalizedText)) {
      violations.push('verbatim_text_not_in_facts');
    }
    return violations;
  }

  if (item.origin === 'assembled') {
    for (const value of Array.isArray(item.values) ? item.values : []) {
      const valueTokens = tokenize(value.text).join(' ');
      if (valueTokens && !tokenize(source).join(' ').includes(valueTokens)) {
        violations.push(`assembled_value_not_in_facts:${value.text.slice(0, 40)}`);
      }
    }
    return violations;
  }

  // ai_rewritten: rewording is allowed, invention is not.
  const words = contentTokens(item.text);
  if (words.length) {
    const templateTokens = new Set(TEMPLATE_PHRASES.flatMap(tokenize));
    const meaningful = words.filter(word => !templateTokens.has(word));
    const grounded = meaningful.filter(word => sourceTokens.has(word)).length;
    if (meaningful.length && grounded / meaningful.length < 0.5) {
      violations.push(`insufficient_overlap:${grounded}/${meaningful.length}`);
    }
    // A ratio over a long paragraph can absorb a short fabricated clause
    // ("licensed professional engineer holding an active federal clearance").
    // Bound ungrounded content absolutely: a run of 4+ consecutive meaningful
    // words with no source backing is an invention regardless of the ratio.
    let run = [];
    for (const word of meaningful) {
      if (sourceTokens.has(word)) { run = []; continue; }
      run.push(word);
      if (run.length >= 4) {
        violations.push(`ungrounded_run:${run.join(' ')}`);
        break;
      }
    }
  }
  // CJK text carries claims the Latin tokenizer cannot see — it contributes
  // no tokens to any check above. Every CJK run must therefore appear
  // verbatim in the source facts; otherwise a whole fabricated sentence
  // would pass as if it were whitespace.
  const cjkRuns = String(item.text).match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/gu) || [];
  for (const cjkRun of cjkRuns) {
    if (!source.includes(cjkRun)) {
      violations.push(`ungrounded_cjk_text:${cjkRun.slice(0, 20)}`);
    }
  }
  for (const noun of properNounTokens(item.text)) {
    const grounded = sourceTokens.has(noun)
      // "AT&T" / "O'Reilly": the tokenizer shreds punctuated names, so the
      // whole spelling is checked against the raw source instead.
      || (/[^a-z0-9]/.test(noun) && source.toLowerCase().includes(noun));
    if (!grounded) violations.push(`unknown_proper_noun:${noun}`);
  }
  return violations;
}

// Single-item grounding check, exported so the cover-letter engine runs THE
// SAME rules rather than a near-copy that could drift. `extra_grounding` is
// honored exactly as mergeAiTailoring honors it for the resume summary: our
// code sets it to the job's own identity words (title, company) — data from
// the posting, not fabrication — and nothing an AI returns can widen it,
// because merge code builds items explicitly and never copies that field
// from model output.
export function groundingViolationsFor(item, profile) {
  const source = groundingSourceFor(item, profile);
  if (!source.ok) return [source.reason];
  const widened = item.extra_grounding ? `${source.source} ${item.extra_grounding}` : source.source;
  return validateItemAgainstSource(item, widened);
}

export function validateDraftGrounding(draft, profile) {
  const violations = [];
  const inspect = (item, where) => {
    // job_scaffold items are built from the POSTING's own words (the
    // "Candidate for <job title>." intent line) — they claim nothing about
    // the candidate and cite no facts, same as the cover letter's opening.
    if (item.origin === 'job_scaffold') return;
    const source = groundingSourceFor(item, profile);
    if (!source.ok) {
      violations.push(`${where}: ${source.reason}`);
      return;
    }
    // Honor extra_grounding the same way groundingViolationsFor does — a
    // merged summary legitimately carries the job-title words our merge code
    // stamped onto it.
    const widened = item.extra_grounding ? `${source.source} ${item.extra_grounding}` : source.source;
    for (const violation of validateItemAgainstSource(item, widened)) {
      violations.push(`${where}: ${violation}`);
    }
  };
  for (const block of Array.isArray(draft?.blocks) ? draft.blocks : []) {
    (block.items || []).forEach((item, index) => inspect(item, `${block.kind}[${index}]`));
    (block.entries || []).forEach((entry, entryIndex) => {
      (entry.bullets || []).forEach((bullet, bulletIndex) =>
        inspect(bullet, `${block.kind}[${entryIndex}].bullets[${bulletIndex}]`));
    });
  }
  return { ok: violations.length === 0, violations };
}

// --- AI merge -------------------------------------------------------------

// The bounded input handed to the model: the job, plus a flat inventory of
// referenceable facts. The model never sees anything it could not cite.
export function aiTailoringInput({ profile = {}, job = {} } = {}) {
  const facts = [];
  const push = (ref, value) => {
    const flat = text(factText(value), 500);
    if (flat) facts.push({ ref, text: flat });
  };
  push('career_goals[0]', profile.career_goals?.[0]);
  (profile.experience || []).forEach((entry, index) => {
    push(`experience[${index}]`, `${entry.role} at ${entry.company}`);
    (entry.achievements || []).forEach((bullet, bulletIndex) => push(`experience[${index}].achievements[${bulletIndex}]`, bullet));
    (entry.responsibilities || []).forEach((bullet, bulletIndex) => push(`experience[${index}].responsibilities[${bulletIndex}]`, bullet));
    // Technologies are confirmed facts too. Leaving them out made keyword
    // coverage call a tool the user demonstrably used a "gap".
    (entry.technologies || []).forEach((tool, toolIndex) => push(`experience[${index}].technologies[${toolIndex}]`, tool));
  });
  (profile.projects || []).forEach((entry, index) => {
    push(`projects[${index}].description`, entry.description);
    (entry.results || []).forEach((result, resultIndex) => push(`projects[${index}].results[${resultIndex}]`, result));
  });
  (profile.education || []).forEach((entry, index) => push(`education[${index}]`, entry));
  Object.entries(profile.skills || {}).forEach(([group, items]) => {
    (Array.isArray(items) ? items : []).forEach((skill, index) => push(`skills.${group}[${index}]`, skill));
  });
  return {
    job: { title: text(job.title, 300), description: text(job.description_text, 6000) },
    facts: facts.slice(0, 200)
  };
}

// The whole point of the AI summary is targeting THIS job. A summary that
// names no title word and almost no description signal is the generic filler
// the task contract forbids — code enforces what the prompt asks for, because
// "sometimes the summary ignores the job" is exactly what an unenforced
// prompt produces.
export function summaryTargetsJob(summaryText, job = {}) {
  const summaryTokens = new Set(tokenize(summaryText));
  const titleTokens = contentTokens(job.title).filter(token => !NON_SKILL_WORDS.has(token));
  if (titleTokens.some(token => summaryTokens.has(token))) return true;
  let signalHits = 0;
  for (const signal of extractJobSignals(job)) {
    if (summaryTokens.has(signal)) signalHits += 1;
    if (signalHits >= 3) return true;
  }
  return false;
}

// A model may cite an offered fact or any sub-path inside one — citing
// "projects[0].description" under an offered "projects[0]" narrows the
// grounding source, which is safer, not less honest. Anything outside the
// offered inventory (identity, contact details) is refused.
export function refWithinOffered(ref, offeredRefs) {
  if (offeredRefs.has(ref)) return true;
  for (const offered of offeredRefs) {
    if (ref.startsWith(offered) && (ref[offered.length] === '.' || ref[offered.length] === '[')) return true;
  }
  return false;
}

// Validator handed to structuredTask as its schema callback.
export function validateResumeTailoringOutput(value) {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'not_an_object' };
  if (!value.summary || typeof value.summary.text !== 'string' || !Array.isArray(value.summary.fact_refs)) {
    return { ok: false, reason: 'summary_shape' };
  }
  if (!Array.isArray(value.bullet_rewrites)) return { ok: false, reason: 'bullet_rewrites_shape' };
  for (const rewrite of value.bullet_rewrites) {
    if (typeof rewrite?.fact_ref !== 'string' || typeof rewrite?.text !== 'string') {
      return { ok: false, reason: 'rewrite_shape' };
    }
  }
  return { ok: true };
}

// Applies an AI tailoring result to a deterministic draft. All-or-nothing:
// one ungrounded line rejects the whole contribution.
export function mergeAiTailoring(draft, aiResult, profile, { job = {} } = {}) {
  const violations = [];
  const shape = validateResumeTailoringOutput(aiResult);
  if (!shape.ok) {
    return { draft, ai: { status: 'rejected_ungrounded', violations: [`output_shape:${shape.reason}`] } };
  }
  // A summary that ignores the job is a quality failure, not a trust one:
  // no merge, no rejection — the caller retries, and the deterministic
  // fallback names the job title itself.
  if (text(job.title) && !summaryTargetsJob(aiResult.summary.text, job)) {
    return { draft, ai: { status: 'fallback_summary_not_targeted' } };
  }

  const candidates = [];
  const summaryItem = {
    origin: 'ai_rewritten',
    text: text(aiResult.summary.text, 800),
    fact_refs: aiResult.summary.fact_refs,
    // The summary is ALLOWED to name the target job — the title comes from
    // the input, so its words are data, not fabrication. Grounding widens by
    // exactly these words and nothing else.
    extra_grounding: text(job.title, 300)
  };
  candidates.push({ item: summaryItem, where: 'ai.summary' });

  const rewriteByRef = new Map();
  for (const rewrite of aiResult.bullet_rewrites.slice(0, 40)) {
    const item = {
      origin: 'ai_rewritten',
      text: text(rewrite.text, 600),
      fact_refs: [rewrite.fact_ref]
    };
    candidates.push({ item, where: `ai.rewrite(${rewrite.fact_ref})` });
    rewriteByRef.set(rewrite.fact_ref, item);
  }

  // Model-supplied refs must come from the inventory the model was shown.
  // resolveFactRef would happily resolve identity/contact paths the input
  // deliberately withheld — citing them would launder the candidate's name
  // and phone digits into the grounding source.
  const offeredRefs = new Set(aiTailoringInput({ profile, job }).facts.map(fact => fact.ref));
  for (const candidate of candidates) {
    for (const ref of Array.isArray(candidate.item.fact_refs) ? candidate.item.fact_refs : []) {
      if (!refWithinOffered(ref, offeredRefs)) violations.push(`${candidate.where}: ref_not_offered:${ref}`);
    }
  }

  for (const candidate of candidates) {
    const source = groundingSourceFor(candidate.item, profile);
    if (!source.ok) {
      violations.push(`${candidate.where}: ${source.reason}`);
      continue;
    }
    const groundedSource = candidate.item.extra_grounding
      ? `${source.source} ${candidate.item.extra_grounding}`
      : source.source;
    for (const violation of validateItemAgainstSource(candidate.item, groundedSource)) {
      violations.push(`${candidate.where}: ${violation}`);
    }
  }
  if (violations.length) {
    return { draft, ai: { status: 'rejected_ungrounded', violations: violations.slice(0, 20) } };
  }

  // A rewrite that shrinks the fact is worse than no rewrite: models trade
  // content for brevity, and the words they drop are often exactly the ones
  // the job asked for. Each rewrite must keep every source token that also
  // appears in the job text, and most of the source's content overall.
  // Content loss is a quality problem, not a grounding violation, so a
  // failing rewrite is skipped (original bullet kept) instead of rejecting
  // the whole AI contribution.
  const jobTokens = new Set(contentTokens(`${job.title || ''} ${job.description_text || ''}`));
  const rewritesSkipped = [];
  for (const [ref, item] of [...rewriteByRef]) {
    const source = groundingSourceFor(item, profile);
    if (!source.ok) continue;
    const sourceTokens = [...new Set(contentTokens(source.source))];
    const rewriteTokens = new Set(contentTokens(item.text));
    const droppedJobMatch = sourceTokens.some(token => jobTokens.has(token) && !rewriteTokens.has(token));
    const kept = sourceTokens.filter(token => rewriteTokens.has(token)).length;
    const retention = sourceTokens.length ? kept / sourceTokens.length : 1;
    if (droppedJobMatch || retention < 0.55) {
      rewriteByRef.delete(ref);
      rewritesSkipped.push(ref);
    }
  }

  // Everything checked out: replace the assembled summary and swap reworded
  // bullets in place, keeping the original as provenance.
  const merged = structuredClone(draft);
  for (const block of merged.blocks) {
    if (block.kind === 'summary') {
      block.items = [{ ...summaryItem, replaced: block.items[0]?.text || '' }];
    }
    for (const entry of block.entries || []) {
      entry.bullets = (entry.bullets || []).map(bullet => {
        const rewrite = rewriteByRef.get(bullet.fact_refs[0]);
        return rewrite ? { ...rewrite, relevance: bullet.relevance, replaced: bullet.text } : bullet;
      });
    }
  }
  if (!merged.blocks.some(block => block.kind === 'summary')) {
    merged.blocks.unshift({ kind: 'summary', items: [summaryItem] });
  }
  return {
    draft: merged,
    ai: {
      status: 'ok',
      rewrites_applied: rewriteByRef.size,
      ...(rewritesSkipped.length ? { rewrites_skipped_content_loss: rewritesSkipped.length } : {})
    }
  };
}
