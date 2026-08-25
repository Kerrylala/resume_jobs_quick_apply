import { normalizeJobRecord } from './job_records.mjs';
import { searchConfigurationFingerprint } from './workflow_state.mjs';

function enabledKeywords(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter(item => item && item.enabled !== false)
    .map(item => String(typeof item === 'string' ? item : item.keyword || '').trim())
    .filter(Boolean);
}

export function buildOfflineDemoDiscovery({
  searchPreferences,
  dashboardPort,
  now = new Date().toISOString()
}) {
  const active = (Array.isArray(searchPreferences?.search_profiles)
    ? searchPreferences.search_profiles
    : []).find(profile => profile?.id === searchPreferences?.active_search_profile_id) || null;
  const role = enabledKeywords(active?.target_roles)[0] || 'Software Engineer';
  const location = enabledKeywords(active?.preferred_locations)[0] || 'Remote';
  const requiredSkills = enabledKeywords(active?.required_skills);
  const preferredSkills = enabledKeywords(active?.preferred_skills);
  const skills = [...new Set([...requiredSkills, ...preferredSkills])];
  const description = [
    `This is a synthetic offline demo opening for a ${role}.`,
    `The role is configured for ${location}.`,
    skills.length
      ? `The synthetic description includes these configured skills: ${skills.join(', ')}.`
      : 'The synthetic description covers collaboration, delivery, communication, and product-quality work.',
    'It exists only to demonstrate matching, approval, package creation, and localhost-only safe autofill.',
    'No employer, recruiter, application, or external website is associated with this record.'
  ].join(' ');
  const jobUrl = `http://127.0.0.1:${Number(dashboardPort)}/mock-ats/jobs/123456`;
  const fingerprint = searchConfigurationFingerprint(searchPreferences);
  const job = normalizeJobRecord({
    source: 'offline_demo_fixture',
    source_job_id: 'resume-jobs-offline-demo-001',
    company: 'Resume Jobs Demo Company',
    title: role,
    location,
    country_or_region: location,
    remote_policy: /\bremote\b/i.test(location) ? 'remote' : 'any',
    seniority: enabledKeywords(active?.seniority_levels).find(value => value !== 'any') || 'mid',
    job_type: enabledKeywords(active?.job_types).find(value => value !== 'any') || 'full_time',
    salary_min: Number(active?.minimum_salary) || null,
    provider: 'generic_company_careers',
    ats: 'mock',
    url: jobUrl,
    apply_url: jobUrl,
    description_text: `${description} ${description}`,
    posted_at: now,
    discovered_at: now,
    page_type: 'job_detail',
    info_quality: { score: 100 },
    confidence: 0.99,
    application_mode: 'REVIEW_ONLY',
    submit_allowed: false,
    upload_resume_allowed: false,
    final_submit_allowed: false,
    risk_level: 'synthetic_localhost_demo',
    tags: ['offline_demo', 'synthetic', 'localhost_only'],
    search_configuration_fingerprint: fingerprint,
    notes: 'Synthetic localhost-only record created by an explicit Dashboard demo action.'
  }, { now, defaultSource: 'offline_demo_fixture' });

  const searchRun = {
    run_id: `offline_demo_${Date.parse(now) || Date.now()}`,
    search_configuration_fingerprint: fingerprint,
    search_profile_id: active?.id || '',
    status: 'completed',
    started_at: now,
    completed_at: now,
    provider: 'offline_demo_fixture',
    provider_reachable: false,
    discovered_urls_count: 1,
    deduped_jobs_count: 1,
    error: '',
    mode: 'offline_demo',
    network_accessed: false
  };

  return {
    job,
    searchRun,
    providerHealth: {
      generated_at: now,
      offline_demo_fixture: {
        ok: true,
        mode: 'offline_demo',
        network_accessed: false,
        localhost_only: true,
        result_count: 1
      }
    }
  };
}
