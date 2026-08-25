import { detectProvider } from '../../providers/provider_detector.mjs';

const COMMON_IDENTITY_FIELDS = Object.freeze([
  { key: 'first_name', required: true },
  { key: 'last_name', required: true },
  { key: 'email', required: true },
  { key: 'phone', required: true },
  { key: 'city', required: false },
  { key: 'country', required: false },
  { key: 'linkedin', required: false }
]);

function adapter({ portal, discovery, maturity, expectedFields, notes = [] }) {
  return Object.freeze({
    schema_version: '1.0',
    portal,
    discovery,
    maturity,
    adapter_status: maturity,
    capabilities: Object.freeze({
      detect_application_page: true,
      estimate_completion: true,
      learn_field_mappings: true,
      fill_safe_known_fields: true,
      attach_resume: 'explicit_user_action_only',
      handle_login: false,
      handle_captcha_or_mfa: false,
      final_submit: false
    }),
    expected_fields: Object.freeze(expectedFields),
    notes: Object.freeze(notes)
  });
}

export const PORTAL_ADAPTERS = Object.freeze({
  greenhouse: adapter({
    portal: 'greenhouse',
    discovery: 'existing_public_api_provider',
    maturity: 'fill_preview_supported',
    expectedFields: [
      ...COMMON_IDENTITY_FIELDS,
      { key: 'resume_file', required: true },
      { key: 'cover_letter_angle', required: false },
      { key: 'why_this_role', required: false },
      { key: 'work_authorization', required: false },
      { key: 'sponsorship_required', required: false }
    ],
    notes: ['Existing Greenhouse discovery provider is reused.', 'Custom questions remain reviewable and learnable.']
  }),
  lever: adapter({
    portal: 'lever',
    discovery: 'existing_public_api_provider',
    maturity: 'fill_preview_supported',
    expectedFields: [
      { key: 'full_name', required: true },
      { key: 'email', required: true },
      { key: 'phone', required: true },
      { key: 'city', required: false },
      { key: 'linkedin', required: false },
      { key: 'github', required: false },
      { key: 'portfolio', required: false },
      { key: 'resume_file', required: true },
      { key: 'cover_letter_angle', required: false },
      { key: 'why_this_role', required: false }
    ],
    notes: ['Existing Lever discovery provider is reused.', 'Custom questions remain reviewable and learnable.']
  }),
  workday: adapter({
    portal: 'workday',
    discovery: 'detector_only',
    maturity: 'limited_dynamic_form_preview',
    expectedFields: [
      ...COMMON_IDENTITY_FIELDS,
      { key: 'address_line_1', required: false },
      { key: 'state_or_province', required: false },
      { key: 'postal_code', required: false },
      { key: 'school', required: false },
      { key: 'degree', required: false },
      { key: 'major', required: false },
      { key: 'years_experience', required: false },
      { key: 'resume_file', required: true },
      { key: 'work_authorization', required: false },
      { key: 'sponsorship_required', required: false }
    ],
    notes: ['Workday page detection exists; there is no public discovery provider.', 'Dynamic steps and account flows require user interaction.']
  }),
  unknown: adapter({
    portal: 'unknown',
    discovery: 'none',
    maturity: 'generic_estimate_only',
    expectedFields: [
      ...COMMON_IDENTITY_FIELDS,
      { key: 'resume_file', required: true },
      { key: 'why_this_role', required: false }
    ],
    notes: ['Uses conservative generic estimates until a portal is recognized.']
  })
});

function text(value) {
  return String(value ?? '').trim();
}

export function isLeverApplicationUrl(value = '') {
  try {
    const url = new URL(text(value));
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'jobs.lever.co') return false;
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length === 3 && parts[2].toLowerCase() === 'apply';
  } catch {
    return false;
  }
}

export function resolvePortalAdapter(jobOrUrl = {}) {
  const job = typeof jobOrUrl === 'string' ? { url: jobOrUrl } : (jobOrUrl || {});
  const explicit = text(job.ats || job.provider).toLowerCase();
  const detected = explicit && Object.hasOwn(PORTAL_ADAPTERS, explicit)
    ? { provider: explicit, confidence: 1, reason: 'explicit_job_provider' }
    : detectProvider(job.apply_url || job.url || '');
  const portal = Object.hasOwn(PORTAL_ADAPTERS, detected.provider) ? detected.provider : 'unknown';
  const pageUrl = job.apply_url || job.url || '';
  return {
    portal,
    detection: detected,
    application_page_detected: portal === 'lever' ? isLeverApplicationUrl(pageUrl) : null,
    adapter: PORTAL_ADAPTERS[portal]
  };
}
