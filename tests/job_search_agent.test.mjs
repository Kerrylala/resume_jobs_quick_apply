import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJobSearchPlan } from '../scripts/lib/job_search_agent.mjs';

test('Job Search Agent combines direct goals with explainable transferable roles', () => {
  const plan = buildJobSearchPlan({
    careerProfile: {
      id: 'career_fixture',
      career_goals: ['Software Engineer'],
      skills: {
        programming: ['JavaScript'],
        ai_tools: ['LM Studio'],
        business: ['Product discovery'],
        data: ['Analytics']
      },
      job_preferences: { countries: ['China', 'Singapore'] }
    },
    searchPreferences: {
      target_roles: [{ keyword: 'AI Product Manager', enabled: true }],
      preferred_locations: [{ keyword: 'Shanghai', enabled: true }]
    }
  });
  assert.equal(plan.roles[0].role, 'AI Product Manager');
  assert.ok(plan.roles.some(item => item.role === 'Software Engineer' && item.kind === 'direct'));
  assert.ok(plan.roles.some(item => item.role === 'Solutions Engineer' && item.kind === 'transferable'));
  assert.ok(plan.roles.some(item => item.role === 'AI Consultant'));
  assert.ok(plan.queries.some(item => item.region === 'china' && /官网 招聘/.test(item.query)));
  assert.ok(plan.queries.filter(item => item.location === 'Shanghai').every(item => item.region === 'china'));
  assert.deepEqual(plan.target_roles.map(item => item.role).slice(0, 2), ['AI Product Manager', 'Software Engineer']);
  assert.ok(plan.adjacent_roles.some(item => item.role === 'Solutions Engineer'));
  assert.ok(plan.role_groups.technical.some(item => item.role === 'Software Engineer'));
  assert.ok(plan.role_groups.product.some(item => item.role === 'AI Product Manager'));
  assert.ok(plan.role_groups.business.some(item => item.role === 'Solutions Engineer'));
  assert.ok(plan.keywords.includes('JavaScript'));
  assert.ok(plan.sources.some(item => item.market === 'china' && item.source === 'public_job_pages'));
  assert.ok(plan.sources.some(item => item.market === 'global' && item.source === 'ats'));
  assert.ok(plan.queries.every(item => item.query && item.source && item.time && item.reason));
  assert.ok(plan.queries.filter(item => item.region === 'china').every(item =>
    item.preferred_source_types.join(',') === 'company_career,public_job_pages,user_imported_urls'
  ));
  assert.ok(plan.queries.some(item => item.region === 'global' && /careers/.test(item.query)));
  assert.equal(plan.safety.login_or_bypass_requested, false);
});

test('Job Search Agent remains useful without configured locations and records provenance', () => {
  const plan = buildJobSearchPlan({
    careerProfile: { career_goals: ['Product Analyst'], skills: { data: ['SQL'], business: ['Roadmapping'] } },
    maxQueries: 3
  });
  assert.deepEqual(plan.locations, ['Remote']);
  assert.equal(plan.queries.length, 3);
  assert.ok(plan.queries.every(item => item.role_reason));
  assert.ok(plan.queries.every(item => item.reason));
  assert.equal(plan.profile_approved, false);
  assert.ok(plan.queries.every(item => item.preferred_source_types.join(',') === 'ats,career_pages'));
});
