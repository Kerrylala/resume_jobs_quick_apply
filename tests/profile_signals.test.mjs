// Profile signals must flow into matching. The real-world failure this guards:
// resumes bury content in free-text fields (responsibilities, project
// descriptions) and leave role/company/skills empty, so matching that read
// only structured fields saw nothing and every job scored 0-or-binary.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractSkills, deriveRoles, estimateYears, educationLevel, profileLocations, mineSkills,
} from '../scripts/lib/profile_signals.mjs';
import { matchingContextFromCareerProfile, scoreJobForSearch } from '../scripts/lib/search_matching.mjs';

// A sparse-but-real profile: everything lives in free text, structured fields empty.
const PROFILE = {
  user_approved: true,
  education: [{ degree: '本科', field_of_study: '数学-计算机科学 与 经济学', institution: '加州大学圣地亚哥分校' }],
  experience: [
    { role: '', company: '', responsibilities: ['软件工程实习生 马里兰州', '使用Java和Android Studio参与两个内部Android项目开发', 'Synthetic Systems Inc. 2024年06月 - 2024年08月'] },
    { role: '', company: '', responsibilities: ['市场与AI助理 圣地亚哥', '使用GPT、Gamma等工具', '上海合成环境科技 2023年06月 - 2023年09月'] },
  ],
  projects: [{ name: '', description: 'AI 求职自动化平台 2026年04月 - 至今', results: ['Python、Node.js、Playwright、Chrome Extension'] }],
  skills: { programming: [], ai_tools: [] },
  career_goals: [],
};

test('skills are mined from free-text, not just structured fields', () => {
  const skills = extractSkills(PROFILE);
  for (const expected of ['Java', 'Python', 'Node.js', 'Android', 'Playwright', 'Chrome Extension']) {
    assert.ok(skills.includes(expected), `expected mined skill ${expected}, got ${JSON.stringify(skills)}`);
  }
});

test('mineSkills reads Chinese and English tech mentions', () => {
  assert.deepEqual(mineSkills('精通 Java 与 python，用过 机器学习').sort(),
    ['Java', 'Machine Learning', 'Python'].sort());
});

test('roles derive from field-of-study and experience titles', () => {
  const roles = deriveRoles(PROFILE);
  assert.ok(roles.includes('Software Engineer'), 'CS major + intern title → Software Engineer');
  assert.ok(roles.some(r => /Analyst/.test(r)), 'Math/Econ major → an Analyst direction');
});

test('years are estimated from real date ranges, not entry count', () => {
  const years = estimateYears(PROFILE);
  assert.ok(years !== null && years > 0 && years < 5, `sane years estimate, got ${years}`);
  // The old bug returned entry_count*2-1; two entries must NOT yield ~3+ the naive way.
  assert.ok(years <= 2, `internships should total well under 2 years, got ${years}`);
});

test('education level recognizes Chinese 本科', () => {
  assert.equal(educationLevel(PROFILE), 'bachelors');
});

test('locations are mined bilingually from text', () => {
  const locs = profileLocations(PROFILE);
  assert.ok(locs.includes('上海') || locs.includes('Shanghai'));
  assert.ok(locs.includes('圣地亚哥') || locs.includes('San Diego'));
});

test('matching context is populated and produces a real score spread', () => {
  const ctx = matchingContextFromCareerProfile(PROFILE);
  assert.ok(ctx.skills.length >= 5, 'context carries mined skills');
  assert.ok(ctx.career_terms.length >= 3, 'context carries derived career terms');
  assert.equal(ctx.years_experience !== null, true);

  // A matching SWE job scores clearly higher than an unrelated one.
  const swe = scoreJobForSearch({
    title: 'Software Engineer', company: 'Acme', location: 'Shanghai',
    description_text: 'Build backend services in Python and Java. Bachelor degree.',
  }, ctx);
  const writer = scoreJobForSearch({
    title: 'Freelance Writer', company: 'Blog', location: 'Remote',
    description_text: 'Write articles about lifestyle. No technical skills needed.',
  }, ctx);
  assert.ok(swe.match_score > writer.match_score, `SWE (${swe.match_score}) should beat writer (${writer.match_score})`);
  assert.ok(swe.match_score >= 60, `a strong-fit SWE job should score high, got ${swe.match_score}`);
  assert.ok(swe.why_fit.length > 0, 'a matched job explains why it fits');
});
