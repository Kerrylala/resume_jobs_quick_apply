// The single backend readiness projection for the Application Profile.
// It resolves the exact same projected profile and field keys the executor's
// approved-mapping builder consumes, so the UI can never claim "profile
// approved" while the executor sees no usable profile (acceptance #19).
import { careerProfileToApplicationProfile } from './career_brain.mjs';
import { normalizeAnswerMemory } from './candidate_records.mjs';
import { EXECUTOR_FIELD_KEYS } from '../../application_executor/execution_session.mjs';
import { profileValue } from '../../application_executor/field_mapper.mjs';

const FIELD_LABELS = {
  full_name: 'Full name',
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone',
  location: 'Current location',
  linkedin_url: 'LinkedIn',
  github_url: 'GitHub',
  portfolio_url: 'Portfolio'
};

const REQUIRED_FOR_SAFE_FILL = new Set(['full_name', 'email', 'phone', 'location']);

// The basics setup asks for once, and the number the product quotes back to the
// user ("N of 9 basic fields"). The executor can fill more than this — current
// company and title, for example — but those are ordinary profile facts rather
// than part of the one-time setup, so they must not inflate this count.
const CORE_PROFILE_FIELDS = Object.freeze([
  'full_name', 'first_name', 'last_name', 'email', 'phone',
  'location', 'linkedin_url', 'github_url', 'portfolio_url'
]);

export function buildApplicationProfileView({ careerProfile = null, legacyProfile = {}, answerMemory = {} } = {}) {
  const approved = careerProfile?.user_approved === true;
  const projected = approved ? careerProfileToApplicationProfile(careerProfile, legacyProfile) : {};
  const fields = EXECUTOR_FIELD_KEYS.map(key => {
    const resolved = approved ? profileValue(projected, key) : { value: '', user_confirmed: false };
    const value = String(resolved?.value || '').trim();
    const usable = Boolean(value) && resolved?.user_confirmed !== false;
    return {
      key,
      label: FIELD_LABELS[key] || key,
      filled: usable,
      derived_unconfirmed: Boolean(value) && resolved?.user_confirmed === false,
      required: REQUIRED_FOR_SAFE_FILL.has(key)
    };
  });
  const coreFields = fields.filter(field => CORE_PROFILE_FIELDS.includes(field.key));
  const missing = coreFields.filter(field => !field.filled).map(field => field.key);
  const answers = normalizeAnswerMemory(answerMemory).answers;
  const savedAnswers = answers.filter(answer => answer.user_confirmed === true);
  const safeReusable = answers.filter(answer => answer.approved_for_real_applications === true);
  const needsUser = [];
  if (!approved) {
    needsUser.push({ id: 'approve_profile', label: 'Review and approve your Career Profile', kind: 'profile_approval' });
  }
  for (const field of fields) {
    if (field.required && !field.filled) {
      needsUser.push({ id: `profile_${field.key}`, label: `Enter your ${field.label.toLowerCase()}`, kind: 'missing_profile' });
    }
    if (field.derived_unconfirmed) {
      needsUser.push({ id: `confirm_${field.key}`, label: `Confirm your ${field.label.toLowerCase()}`, kind: 'unconfirmed_profile' });
    }
  }
  const requiredMissing = fields.some(field => field.required && !field.filled);
  return {
    approved,
    profile: approved ? projected : null,
    readiness: {
      basic_fields: {
        total: coreFields.length,
        filled: coreFields.filter(field => field.filled).length,
        missing
      },
      fields,
      saved_answers: savedAnswers.length,
      safe_reusable_answers: safeReusable.length,
      ready_for_safe_fill: approved && !requiredMissing,
      needs_user: needsUser
    }
  };
}
