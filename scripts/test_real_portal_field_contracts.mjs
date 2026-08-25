import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = JSON.parse(fs.readFileSync(
  path.join(root, 'extensions/application_assistant/site_rules.local.example.json'),
  'utf8'
));

const targets = [
  {
    portal: 'greenhouse',
    domainRule: 'greenhouse.io',
    url: 'https://job-boards.greenhouse.io/canonical/jobs/6643484',
    expected: [
      ['id', 'first_name', 'first_name'],
      ['id', 'last_name', 'last_name'],
      ['id', 'email', 'email'],
      ['id', 'phone', 'phone']
    ]
  },
  {
    portal: 'lever',
    domainRule: 'lever.co',
    url: 'https://jobs.lever.co/pattern/da29eb40-18a4-4d65-a049-b052ecbcd84a/apply',
    expected: [
      ['name', 'name', 'full_name'],
      ['name', 'email', 'email'],
      ['name', 'phone', 'phone'],
      ['name', 'location', 'city'],
      ['name', 'urls[LinkedIn]', 'linkedin'],
      ['name', 'urls[Portfolio]', 'portfolio']
    ],
    mappingOnly: [
      ['name', 'urls[GitHub]', 'github'],
      ['name', 'urls[Github]', 'github']
    ]
  }
];

function plainText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2713;|&#10003;/gi, '✓')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelForField(html, fieldIndex) {
  const labelStart = html.lastIndexOf('<label', fieldIndex);
  const priorLabelEnd = html.lastIndexOf('</label>', fieldIndex);
  if (labelStart < 0 || labelStart < priorLabelEnd) return '';
  const labelEnd = html.indexOf('</label>', fieldIndex);
  if (labelEnd < 0) return '';
  const labelHtml = html.slice(labelStart, labelEnd + 8);
  const applicationLabel = labelHtml.match(/<[^>]*class=["'][^"']*application-label[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1];
  return plainText(applicationLabel || labelHtml);
}

function parseFields(html) {
  return [...html.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)].map(match => {
    const attributes = match[2];
    const read = name => attributes.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'))?.[1] || '';
    return {
      tag: match[1].toLowerCase(),
      type: read('type').toLowerCase(),
      name: read('name'),
      id: read('id'),
      autocomplete: read('autocomplete'),
      label: labelForField(html, match.index)
    };
  });
}

function exactRule(domainRule, attribute, value) {
  return rules[domainRule]?.field_rules?.find(rule => rule.match?.[attribute] === value) || null;
}

const report = {
  schema_version: '1.0',
  generated_at: new Date().toISOString(),
  mode: 'read_only_public_field_contract',
  target_filter: '',
  portals: [],
  safety: {
    personal_values_sent: false,
    form_values_written: false,
    resume_uploaded: false,
    submit_clicked: false,
    login_attempted: false
  }
};

const portalFlagIndex = process.argv.indexOf('--portal');
const selectedPortal = portalFlagIndex >= 0 ? String(process.argv[portalFlagIndex + 1] || '').trim().toLowerCase() : '';
const selectedTargets = selectedPortal ? targets.filter(target => target.portal === selectedPortal) : targets;
report.target_filter = selectedPortal || 'all';

let failed = false;
if (selectedPortal && selectedTargets.length !== 1) {
  throw new Error(`Unknown or ambiguous portal filter: ${selectedPortal}`);
}
for (const target of selectedTargets) {
  try {
    const response = await fetch(target.url, {
      headers: { Accept: 'text/html', 'User-Agent': 'ResumeJobs-Product-QA/1.0' },
      redirect: 'follow'
    });
    const html = await response.text();
    const fields = parseFields(html);
    const checks = target.expected.map(([attribute, value, profileKey]) => {
      const fieldPresent = fields.some(field => field[attribute] === value);
      const rule = exactRule(target.domainRule, attribute, value);
      return {
        attribute,
        field: value,
        expected_profile_key: profileKey,
        field_present: fieldPresent,
        exact_rule_present: rule?.profile_key === profileKey,
        pass: fieldPresent && rule?.profile_key === profileKey
      };
    });
    const mappingChecks = (target.mappingOnly || []).map(([attribute, value, profileKey]) => {
      const rule = exactRule(target.domainRule, attribute, value);
      return {
        attribute,
        field: value,
        expected_profile_key: profileKey,
        exact_rule_present: rule?.profile_key === profileKey,
        pass: rule?.profile_key === profileKey
      };
    });
    const detectedFields = fields
      .filter(field => field.type !== 'hidden')
      .map(field => {
        const attribute = field.name ? 'name' : 'id';
        const value = field[attribute];
        const rule = value ? exactRule(target.domainRule, attribute, value) : null;
        const hardBlocked = field.type === 'file' || ['submit', 'button', 'reset', 'password'].includes(field.type);
        return {
          label: field.label || '(unlabeled)',
          tag: field.tag,
          type: field.type || field.tag,
          name: field.name,
          id: field.id,
          mapped_profile_key: rule?.profile_key || '',
          result: hardBlocked ? 'skipped' : (rule ? 'safe_known_field' : 'skipped'),
          reason: hardBlocked
            ? (field.type === 'file' ? 'file_upload_disabled' : `hard_blocked_input_type_${field.type}`)
            : (rule ? 'exact_reviewed_site_rule' : 'no_exact_reviewed_mapping')
        };
      });
    const portalPass = response.ok
      && checks.every(check => check.pass)
      && mappingChecks.every(check => check.pass)
      && rules[target.domainRule]?.resume_upload_enabled === false
      && rules[target.domainRule]?.resume_upload_mode === 'disabled';
    if (!portalPass) failed = true;
    report.portals.push({
      portal: target.portal,
      status: response.status,
      final_url: response.url,
      fields_detected: fields.filter(field => field.type !== 'hidden').length,
      file_fields_detected: fields.filter(field => field.type === 'file').length,
      checks,
      mapping_checks: mappingChecks,
      detected_fields: detectedFields,
      diagnostics: {
        detected: detectedFields.length,
        safe_known_fields: detectedFields.filter(field => field.result === 'safe_known_field').length,
        skipped: detectedFields.filter(field => field.result === 'skipped').length
      },
      resume_upload_enabled: rules[target.domainRule]?.resume_upload_enabled === true,
      pass: portalPass
    });
  } catch (error) {
    failed = true;
    report.portals.push({ portal: target.portal, pass: false, error: error.message });
  }
}

console.log(JSON.stringify(report, null, 2));
if (failed) process.exitCode = 1;
