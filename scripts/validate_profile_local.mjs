#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const profilePath = path.resolve(process.env.RESUME_JOBS_PROFILE_PATH || path.join(repoRoot, 'extensions/application_assistant/profile.local.json'));
const reportsDir = path.resolve(process.env.RESUME_JOBS_REPORTS_DIR || path.join(repoRoot, 'reports'));
const reportJsonPath = path.join(reportsDir, 'profile_local_validation_001.json');
const reportMdPath = path.join(reportsDir, 'profile_local_validation_001.md');

const requiredIdentityFields = [
  'approved_for_real_applications',
  'allow_autofill_real_sites',
  'allow_resume_attach',
  'allow_final_submit',
  'review_required_before_real_applications',
  'profile_type',
  'full_name',
  'first_name',
  'last_name',
  'email',
  'phone',
  'city',
  'state_or_province',
  'country',
  'address_line_1',
  'address_line_2',
  'postal_code',
  'linkedin',
  'github',
  'portfolio',
  'school',
  'degree',
  'discipline',
  'major',
  'graduation_year',
  'graduation_month',
  'work_authorization',
  'sponsorship',
  'salary_expectation',
  'earliest_start_date',
  'notice_period',
  'years_experience',
  'summary',
  'preferred_name',
  'pronouns',
  'gender',
  'race_ethnicity',
  'veteran_status',
  'disability_status',
  'lgbtq_status',
  'notes'
];

const requiredWhenApproved = ['first_name', 'last_name', 'email', 'phone', 'country'];
const optionalRecommendedWhenApproved = ['linkedin', 'portfolio'];
const exampleLikePatterns = [
  /alex\s+example/i,
  /example\.com/i,
  /alex-example-test/i,
  /example\s+university/i
];
const nonsenseValuePatterns = [
  /\bnah\b/i,
  /\bidk\b/i,
  /helicopter/i,
  /\btodo\b/i,
  /fill\s*(me|this)\s*(in)?/i,
  /replace\s+with/i,
  /placeholder/i,
  /random/i,
  /test\s+value/i
];
const forbiddenKeyPatterns = [
  /password/i,
  /passcode/i,
  /otp/i,
  /one[_-]?time/i,
  /verification[_-]?code/i,
  /sms[_-]?code/i,
  /email[_-]?code/i,
  /token/i,
  /api[_-]?key/i,
  /secret/i,
  /credential/i,
  /captcha/i,
  /resume/i,
  /cv[_-]?file/i,
  /file[_-]?content/i,
  /binary/i,
  /base64/i
];
const resumeContentValuePatterns = [
  /^data:application\//i,
  /^data:.*;base64,/i,
  /JVBERi0/i,
  /UEsDB/i
];

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function flattenEntries(value, prefix = '') {
  const entries = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => entries.push(...flattenEntries(item, `${prefix}[${index}]`)));
    return entries;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      entries.push([childPath, child]);
      entries.push(...flattenEntries(child, childPath));
    }
    return entries;
  }
  return entries;
}

async function writeReports(report) {
  await mkdir(path.dirname(reportJsonPath), { recursive: true });
  await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    '# profile.local.json Validation 001',
    '',
    `- Profile path: \`${report.profile_path}\``,
    `- Exists: ${report.profile_exists ? 'yes' : 'no'}`,
    `- Success: ${report.success ? 'yes' : 'no'}`,
    `- Status: ${report.status}`,
    `- approved_for_real_applications: ${report.approved_for_real_applications === null ? '(missing)' : report.approved_for_real_applications}`,
    `- allow_autofill_real_sites: ${report.allow_autofill_real_sites === null ? '(missing)' : report.allow_autofill_real_sites}`,
    `- allow_resume_attach: ${report.allow_resume_attach === null ? '(missing)' : report.allow_resume_attach}`,
    `- allow_final_submit: ${report.allow_final_submit === null ? '(missing)' : report.allow_final_submit}`,
    '',
    '## Errors',
    '',
    ...(report.errors.length ? report.errors.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Warnings',
    '',
    ...(report.warnings.length ? report.warnings.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Next Steps',
    '',
    ...report.next_steps.map((item, index) => `${index + 1}. ${item}`)
  ];
  await writeFile(reportMdPath, `${lines.join('\n')}\n`);
}

async function main() {
  const report = {
    report_id: 'profile_local_validation_001',
    created_at: new Date().toISOString(),
    profile_path: path.relative(repoRoot, profilePath),
    profile_exists: existsSync(profilePath),
    json_valid: false,
    success: true,
    status: 'missing_optional_private_profile',
    approved_for_real_applications: null,
    allow_autofill_real_sites: null,
    allow_resume_attach: null,
    allow_final_submit: null,
    review_required_before_real_applications: null,
    required_identity_fields_present: false,
    no_example_like_values: true,
    no_nonsense_or_todo_values: true,
    race_ethnicity_array_valid: true,
    no_resume_file_content_stored: true,
    no_password_token_otp_fields: true,
    errors: [],
    warnings: [],
    next_steps: [
      'If profile.local.json is missing, copy extensions/application_assistant/profile.local.template.json to extensions/application_assistant/profile.local.json.',
      'Fill only fields you approve for real job applications.',
      'Set approved_for_real_applications=true and allow_autofill_real_sites=true only when the profile is reviewed and ready for real-site autofill.',
      'Keep allow_resume_attach=false unless the user explicitly enables resume attach.',
      'Keep allow_final_submit=false; final Submit / Apply / Send / Confirm remains manual.',
      'Keep profile.local.json private and gitignored.',
      'Use the popup Settings → Clear stored profile button to remove stale fake/example profile values from Chrome storage before real-site testing.'
    ]
  };

  if (!report.profile_exists) {
    report.warnings.push('profile.local.json is missing. This is allowed; create it from profile.local.template.json before real-site testing.');
    await writeReports(report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  let profile;
  try {
    profile = JSON.parse(await readFile(profilePath, 'utf8'));
    report.json_valid = true;
  } catch (error) {
    report.success = false;
    report.status = 'invalid_json';
    report.errors.push(`profile.local.json is not valid JSON: ${error.message}`);
    await writeReports(report);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  if (!isPlainObject(profile)) {
    report.success = false;
    report.status = 'invalid_shape';
    report.errors.push('profile.local.json must contain a JSON object.');
  }

  for (const key of ['approved_for_real_applications', 'allow_autofill_real_sites', 'allow_resume_attach', 'allow_final_submit', 'review_required_before_real_applications']) {
    if (typeof profile[key] !== 'boolean') {
      report.errors.push(`${key} must be a boolean.`);
    } else {
      report[key] = profile[key];
    }
  }

  if (profile.profile_meta && typeof profile.profile_meta === 'object') {
    for (const key of ['approved_for_real_applications', 'allow_autofill_real_sites', 'allow_resume_attach', 'allow_final_submit', 'review_required_before_real_applications']) {
      if (typeof profile.profile_meta[key] !== 'boolean') report.errors.push(`profile_meta.${key} must be a boolean.`);
    }
  }
  if (profile.allow_final_submit !== false || (profile.profile_meta && profile.profile_meta.allow_final_submit !== false)) {
    report.errors.push('allow_final_submit must remain false. Final Submit / Apply / Send / Confirm is manual only.');
  }

  const missingFields = requiredIdentityFields.filter((key) => !Object.prototype.hasOwnProperty.call(profile, key));
  report.required_identity_fields_present = missingFields.length === 0;
  if (missingFields.length) report.errors.push(`Required identity fields missing: ${missingFields.join(', ')}`);

  const allEntries = flattenEntries(profile);
  const allTextValues = allEntries
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => `${key}: ${value}`);
  const suspiciousValueFindings = [];
  for (const text of allTextValues) {
    for (const pattern of exampleLikePatterns) {
      if (pattern.test(text)) {
        report.no_example_like_values = false;
        suspiciousValueFindings.push(`Example-like value detected: ${text}`);
      }
    }
    for (const pattern of nonsenseValuePatterns) {
      if (pattern.test(text)) {
        report.no_nonsense_or_todo_values = false;
        suspiciousValueFindings.push(`Nonsense/TODO/test value detected: ${text}`);
      }
    }
  }

  const raceEthnicityWarnings = [];
  const raceEthnicityValues = [profile.race_ethnicity, profile.eeo_optional && profile.eeo_optional.race_ethnicity].filter((value) => value !== undefined);
  for (const value of raceEthnicityValues) {
    if (!Array.isArray(value)) {
      report.race_ethnicity_array_valid = false;
      raceEthnicityWarnings.push('race_ethnicity must be an array when present, including eeo_optional.race_ethnicity.');
    }
  }

  const allowedPolicyKeys = new Set(['allow_resume_attach', 'profile_meta.allow_resume_attach']);
  for (const [key, value] of allEntries) {
    if (!allowedPolicyKeys.has(key) && forbiddenKeyPatterns.some((pattern) => pattern.test(key))) {
      report.no_password_token_otp_fields = false;
      report.errors.push(`Forbidden key detected: ${key}`);
    }
    if (typeof value === 'string' && resumeContentValuePatterns.some((pattern) => pattern.test(value))) {
      report.no_resume_file_content_stored = false;
      report.errors.push(`Possible resume/file binary content stored at key: ${key}`);
    }
  }

  if (profile.approved_for_real_applications === true || profile.allow_autofill_real_sites === true) {
    if (suspiciousValueFindings.length) report.errors.push(...suspiciousValueFindings);
    if (raceEthnicityWarnings.length) report.errors.push(...raceEthnicityWarnings);
    const missingApproved = requiredWhenApproved.filter((key) => !hasValue(profile[key]));
    if (missingApproved.length) report.errors.push(`real-site autofill approval requires non-empty: ${missingApproved.join(', ')}`);
    const missingRecommended = optionalRecommendedWhenApproved.filter((key) => !hasValue(profile[key]));
    if (missingRecommended.length === optionalRecommendedWhenApproved.length) report.warnings.push('Neither linkedin nor portfolio is present. This is allowed but recommended for many applications.');
    if (profile.approved_for_real_applications !== true) report.errors.push('allow_autofill_real_sites=true requires approved_for_real_applications=true.');
    if (profile.allow_autofill_real_sites !== true) report.errors.push('approved_for_real_applications=true requires allow_autofill_real_sites=true for real-site autofill.');
  } else {
    if (suspiciousValueFindings.length) report.warnings.push(...suspiciousValueFindings);
    if (raceEthnicityWarnings.length) report.warnings.push(...raceEthnicityWarnings);
    report.warnings.push('Real-site autofill approval is false. Set approved_for_real_applications=true and allow_autofill_real_sites=true only after human review.');
  }

  report.success = report.errors.length === 0;
  report.status = report.success ? 'valid' : 'invalid';
  await writeReports(report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.success) process.exitCode = 1;
}

main().catch(async (error) => {
  const report = {
    report_id: 'profile_local_validation_001',
    created_at: new Date().toISOString(),
    profile_path: path.relative(repoRoot, profilePath),
    profile_exists: existsSync(profilePath),
    json_valid: false,
    success: false,
    status: 'validator_error',
    approved_for_real_applications: null,
    errors: [error.message || String(error)],
    warnings: [],
    next_steps: ['Fix the validator/runtime error and rerun node scripts/validate_profile_local.mjs.']
  };
  await writeReports(report);
  console.error(error);
  process.exitCode = 1;
});
