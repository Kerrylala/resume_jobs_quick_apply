// No-login Global Job Search acceptance.
//
// Proves the core engine works with ZERO recruiting-platform logins: it reads
// the user's REAL Career Profile, auto-builds a search plan, searches across
// Web (SearXNG) + ATS + Company Careers + public fetch adapters, then runs the
// full Quality Gate → Dedup → Filter → Match pipeline and reports every number.
//
//   node scripts/acceptance_no_login_search.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSearchQueries } from '../scripts/lib/search_planner.mjs';
import { runGlobalSearch } from '../scripts/lib/search_orchestrator.mjs';
import { normalizeJobRecord, mergeJobRecords } from '../scripts/lib/job_records.mjs';
import { filterJobs } from '../scripts/lib/job_filter_engine.mjs';
import { scoreJobForSearch, matchingContextFromCareerProfile } from '../scripts/lib/search_matching.mjs';
import { extractSalary, extractExperienceYears, extractEducationLevel } from '../scripts/lib/job_filter_engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = new Date().toISOString();

// 1. Real Career Profile (no edits) + auto criteria (no keywords typed).
const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'career_profiles.local.json'), 'utf8'));
const careerProfile = store.profiles.find(p => p.id === store.active_profile_id) || store.profiles[0];
const criteria = {}; // nothing typed — pure "search from my profile"

const plan = buildSearchQueries({ careerProfile, criteria });
console.log('=== SEARCH PLAN (from real profile, zero keywords typed) ===');
console.log('roles:', JSON.stringify(plan.roles));
console.log('entry_level:', plan.entry_level);
console.log(`text_queries: ${plan.text_queries.length}, site_queries: ${plan.site_queries.length}, board_queries: ${plan.board_queries.length}`);
console.log('sample text queries:');
plan.text_queries.slice(0, 10).forEach(q => console.log('   -', q.query));

// 2. Probe SearXNG availability the same way the server does.
async function searxngState() {
  const url = process.env.SEARXNG_URL || 'http://127.0.0.1:8888/search';
  try {
    const res = await fetch(`${url}?q=test&format=json&engines=bing`, { signal: AbortSignal.timeout(6000) });
    return { enabled: res.ok, url, timeout_ms: 8000, engines: 'bing' };
  } catch { return { enabled: false, url, timeout_ms: 8000 }; }
}
const searxng = await searxngState();
console.log('\nSearXNG enabled:', searxng.enabled, '| url:', searxng.url);

// 3. Run the orchestrator — NO browser boards, NO login.
console.log('\n=== RUNNING GLOBAL SEARCH (no login) ===');
const started = Date.now();
const run = await runGlobalSearch({
  criteria, careerProfile, inventoryBoards: [], searxng, includeSeedBoards: true,
  now, limits: { max_board_jobs: 30, max_web_queries: 8, max_site_queries: 8, max_ingest: 20 },
});
console.log(`orchestrator done in ${((Date.now() - started) / 1000).toFixed(0)}s`);

// 4. Per-provider recall.
console.log('\n=== PER-PROVIDER RECALL ===');
const bySource = {};
for (const p of run.providers) {
  const tag = p.status === 'ok' ? 'OK' : p.status;
  console.log(`  ${(p.id || p.label).padEnd(26)} ${String(p.found ?? 0).padStart(4)}  ${tag}`);
}
for (const job of run.jobs) {
  const src = String(job.discovery?.discovered_by || 'unknown').replace('global_search:', '');
  bySource[src] = (bySource[src] || 0) + 1;
}
console.log('raw gated jobs by source:', JSON.stringify(bySource));
console.log(`raw_found: ${run.raw_found}, gated_out: ${run.gated_out}, after gate: ${run.jobs.length}`);

// 5. Normalize + dedup (canonical URL), same as the server pipeline.
const normalized = run.jobs.map(j => normalizeJobRecord(j, { now, defaultSource: 'global_search' })).filter(Boolean);
const merged = mergeJobRecords([], normalized, { now });
const inventory = merged.jobs;
console.log(`\n=== DEDUP === unique after dedup: ${inventory.length} (merged ${merged.duplicates_merged} duplicates)`);

// 6. Filter (hard) then Match — auto criteria means no hard filters bite; run a
//    realistic plan too (entry-level SWE/Data in the US) to show filtering.
const { accepted, filtered } = filterJobs(inventory, criteria);
console.log(`=== FILTER (auto criteria) === accepted: ${accepted.length}, filtered_out: ${filtered.length}`);

const ctx = matchingContextFromCareerProfile(careerProfile);
console.log('\n=== MATCHING CONTEXT (from real profile) ===');
console.log('  skills:', JSON.stringify(ctx.skills.slice(0, 20)));
console.log('  career_terms:', ctx.career_terms.length, '| years:', ctx.years_experience, '| edu:', JSON.stringify(ctx.education_terms.slice(-1)), '| locations:', JSON.stringify(ctx.location_terms));
const scored = accepted.map(job => {
  const m = scoreJobForSearch(job, ctx);
  return { ...job, match_score: m.match_score, why_fit: m.why_fit, main_gaps: m.main_gaps };
});
const ge = t => scored.filter(j => (j.match_score ?? 0) >= t).length;
console.log(`\n=== MATCH === scored: ${scored.length}`);
console.log(`  >= 50: ${ge(50)}   >= 60: ${ge(60)}   >= 70: ${ge(70)}   >= 80: ${ge(80)}`);
const scoreVals = scored.map(j => j.match_score ?? 0);
// Distribution buckets.
const buckets = { '0-19': 0, '20-39': 0, '40-59': 0, '60-79': 0, '80-100': 0 };
for (const v of scoreVals) {
  if (v < 20) buckets['0-19']++; else if (v < 40) buckets['20-39']++;
  else if (v < 60) buckets['40-59']++; else if (v < 80) buckets['60-79']++; else buckets['80-100']++;
}
console.log(`  distribution:`, JSON.stringify(buckets));
console.log(`  score range: ${Math.min(...scoreVals)}..${Math.max(...scoreVals)}, mean ${(scoreVals.reduce((a, b) => a + b, 0) / (scoreVals.length || 1)).toFixed(1)}`);
const ranked = scored.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0));
console.log('\n  TOP 20 by match (with why-fit):');
ranked.slice(0, 20).forEach(j => {
  console.log(`    ${String(j.match_score).padStart(3)}  ${(j.title || '').slice(0, 40).padEnd(40)} @${(j.company || '').slice(0, 18)}`);
  console.log(`         why: ${(j.why_fit || []).join('; ').slice(0, 100) || '(none)'}`);
});
console.log('\n  BOTTOM 5 (sanity check low scores are genuinely unfit):');
ranked.slice(-5).forEach(j => console.log(`    ${String(j.match_score).padStart(3)}  ${(j.title || '').slice(0, 44)} @${j.company || ''} | gaps: ${(j.main_gaps || []).join(', ').slice(0, 60)}`));

// 7. Field completeness across the inventory.
const pct = n => `${Math.round((n / (inventory.length || 1)) * 100)}%`;
let hasDesc = 0, hasLoc = 0, hasSalary = 0, hasExp = 0, hasEdu = 0, hasPosted = 0, hasCompany = 0;
for (const j of inventory) {
  const body = [j.description_text, j.title].filter(Boolean).join(' ');
  if (String(j.description_text || '').length >= 40) hasDesc += 1;
  if (String(j.location || '').trim()) hasLoc += 1;
  if (extractSalary(j.salary?.text || j.salary || body)) hasSalary += 1;
  if (extractExperienceYears(body)) hasExp += 1;
  if (extractEducationLevel(body)) hasEdu += 1;
  if (String(j.posted_date || '').trim()) hasPosted += 1;
  if (String(j.company || '').trim()) hasCompany += 1;
}
console.log('\n=== FIELD COMPLETENESS (inventory) ===');
console.log(`  company ${pct(hasCompany)}  location ${pct(hasLoc)}  description ${pct(hasDesc)}  posted_date ${pct(hasPosted)}`);
console.log(`  salary ${pct(hasSalary)}  experience ${pct(hasExp)}  education ${pct(hasEdu)}`);

console.log('\n=== DONE ===');
