const MOCK_ATS_PATH = '/mock-ats/jobs/123456';

export function isLocalMockAtsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.protocol === 'http:'
      && url.pathname === MOCK_ATS_PATH;
  } catch {
    return false;
  }
}

export function buildLocalMockAtsHandoffUrl(value, { jobId, sessionId } = {}) {
  if (!isLocalMockAtsUrl(value)) return String(value || '');
  const url = new URL(value);
  url.searchParams.set('job_id', String(jobId || ''));
  url.searchParams.set('application_session_id', String(sessionId || ''));
  return url.toString();
}

export function buildLocalMockFillProfile({ job, applicationProfile } = {}) {
  const profile = applicationProfile && typeof applicationProfile === 'object'
    ? applicationProfile
    : {};
  const safeValue = key => typeof profile[key] === 'string' ? profile[key].trim() : '';
  return {
    full_name: safeValue('full_name'),
    first_name: safeValue('first_name'),
    last_name: safeValue('last_name'),
    email: safeValue('email'),
    phone: safeValue('phone'),
    city: safeValue('city'),
    country: safeValue('country'),
    linkedin: safeValue('linkedin'),
    github: safeValue('github'),
    portfolio: safeValue('portfolio'),
    school: safeValue('school'),
    degree: safeValue('degree'),
    major: safeValue('major') || safeValue('discipline'),
    graduation_year: safeValue('graduation_year'),
    desired_role: typeof job?.title === 'string' ? job.title.trim() : '',
    years_experience: safeValue('years_experience'),
    summary: safeValue('summary')
  };
}
