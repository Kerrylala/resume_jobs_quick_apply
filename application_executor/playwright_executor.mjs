import { ApplicationExecutor, EXECUTOR_MODES, assertExecutionContext } from "./executor_interface.mjs";
import { assertSafeExecutionRequest, classifyPageSafety } from "./safety_policy.mjs";
import { adapterForUrl } from "../portal_adapters/index.mjs";
import { approvedFieldProfile } from "./execution_session.mjs";
import { formFieldMemoryRules } from "../scripts/lib/learning_candidates.mjs";
import { questionEquivalenceKey } from "../scripts/lib/candidate_records.mjs";

function fieldQuestionTexts(field = {}) {
  return [field.label, field.placeholder, field.aria_label, field.name, field.id]
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function confirmedSessionRules(session = {}, targetUrl = '', fieldMemory = {}, fields = []) {
  const core = globalThis.ResumeJobsApplicationExecutorCore;
  const answerRules = (Array.isArray(session.approved_field_mappings) ? session.approved_field_mappings : [])
    .filter(mapping => mapping?.user_confirmed === true && Array.isArray(mapping.aliases) && mapping.aliases.length)
    .map(mapping => {
      const aliases = mapping.aliases.map(value => String(value || '').trim()).filter(Boolean);
      const equivalenceKeys = new Set(aliases.map(questionEquivalenceKey).filter(Boolean));
      // A family-keyed answer (q_hear_about_us…) matches every wording of the
      // question, on every portal — that is the whole point of the family.
      const familyKey = String(mapping.canonical_key || '').startsWith('q_')
        ? String(mapping.canonical_key)
        : '';
      for (const field of Array.isArray(fields) ? fields : []) {
        for (const candidate of fieldQuestionTexts(field)) {
          const key = questionEquivalenceKey(candidate);
          if (key && equivalenceKeys.has(key)) aliases.push(candidate);
          else if (familyKey && core?.questionFamilyKey?.(candidate) === familyKey) aliases.push(candidate);
        }
      }
      return {
        key: mapping.canonical_key,
        aliases: [...new Set(aliases)],
        confidence: mapping.confidence,
        source: 'confirmed_answer_memory'
      };
    });
  return [...formFieldMemoryRules(fieldMemory, targetUrl), ...answerRules];
}

export class PlaywrightExecutor extends ApplicationExecutor {
  constructor({ adapterResolver = adapterForUrl } = {}) {
    super(EXECUTOR_MODES.BROWSER_AGENT);
    this.adapterResolver = adapterResolver;
  }

  async execute(context = {}) {
    assertSafeExecutionRequest(context);
    const safe = assertExecutionContext({ ...context, executor: this.mode });
    if (!context.runtime) throw new Error("PlaywrightExecutor requires a browser runtime.");
    const adapter = this.adapterResolver(safe.url);
    const fields = await adapter.get_fields(context.runtime);
    const pageState = typeof context.runtime.getPageState === "function"
      ? await context.runtime.getPageState()
      : { url: safe.url };
    const pageSafety = classifyPageSafety(pageState, safe.url);
    const plans = adapter.map_fields(fields, {
      profile: approvedFieldProfile(safe),
      profile_confirmed: true,
      minimum_confidence: context.minimum_confidence || 0.8,
      site_rules: confirmedSessionRules(safe, safe.url, context.field_memory || {}, fields),
      field_memory: context.field_memory || {},
      sensitive_reuse_categories: Array.isArray(safe.sensitive_reuse_categories) ? safe.sensitive_reuse_categories : [],
    });
    if (pageSafety.action !== "allow") {
      return adapter.report({
        ...safe,
        application_id: context.application_id,
        started_at: context.started_at,
        status: "needs_user_input",
        blocked_reason: pageSafety.reason,
        challenge_scope: pageSafety.challenge_scope,
        submission_blocker: pageSafety.submission_blocker,
        challenge_evidence: pageSafety.evidence,
        notes: ["The application form is blocked by a verification page. Complete it manually, then retry safe filling."],
      }, plans.map(plan => ({
        field: plan.field,
        outcome: "skipped",
        reason: plan.action === "fill" ? "skipped_not_visible" : plan.reason,
      })));
    }
    // A value already on the page that is neither empty, nor the planned
    // value, nor something the product authored earlier, is the USER's edit —
    // a re-run must never clobber it. authored_page_values comes from the
    // learning baseline (values previous attempts wrote).
    const authoredValues = new Set((Array.isArray(context.authored_page_values) ? context.authored_page_values : [])
      .map(value => String(value).trim()).filter(Boolean));
    if (typeof context.runtime.readFieldValue === 'function') {
      for (const plan of plans) {
        if (plan.action !== 'fill' || !plan.mapping) continue;
        if (['radio', 'checkbox', 'file'].includes(String(plan.field?.type))) continue;
        let current = null;
        try { current = await context.runtime.readFieldValue(plan.field.field_ref); } catch { current = null; }
        const existing = current === null ? '' : String(current).trim();
        if (existing && existing !== String(plan.mapping.value).trim() && !authoredValues.has(existing)) {
          plan.action = 'skip';
          plan.reason = 'skipped_user_value_present';
        }
      }
    }
    const fieldResults = await adapter.fill_fields(context.runtime, plans);
    // Portal-side scripts (a resume-parse autofill, SPA re-renders) can
    // rewrite a field AFTER our verified write. Re-read every filled text
    // field once the page settles and report a changed value honestly instead
    // of claiming success the page no longer shows.
    if (typeof context.runtime.readFieldValue === 'function'
      && fieldResults.some(result => result.outcome === 'filled')) {
      await new Promise(resolve => setTimeout(resolve, 2_500));
      const planByFieldRef = new Map(plans.map(plan => [plan.field?.field_ref, plan]));
      for (const result of fieldResults) {
        if (result.outcome !== 'filled') continue;
        const plan = planByFieldRef.get(result.field?.field_ref);
        if (!plan?.mapping || ['radio', 'checkbox', 'file'].includes(String(plan.field?.type))) continue;
        let current = null;
        try { current = await context.runtime.readFieldValue(result.field.field_ref); } catch { current = null; }
        if (current !== null && String(current).trim() !== String(plan.mapping.value).trim()) {
          result.outcome = 'failed';
          result.reason = 'overwritten_by_portal_autofill';
        }
      }
    }
    return adapter.report({
      ...safe,
      application_id: context.application_id,
      started_at: context.started_at,
      status: pageSafety.challenge_scope === "passive" ? "needs_user_input" : "paused_for_user_review",
      challenge_scope: pageSafety.challenge_scope,
      submission_blocker: pageSafety.submission_blocker,
      challenge_evidence: pageSafety.evidence,
      notes: [pageSafety.challenge_scope === "passive"
        ? (pageSafety.submission_blocker === "CAPTCHA_MAY_APPEAR_AT_SUBMIT"
            ? "Safe fields were filled. The site may show a verification when you submit — it stays yours to complete."
            : "Safe fields were filled. Complete the verification manually before submitting.")
        : "Browser Agent paused before upload, authentication, challenges, and final submission."],
    }, fieldResults);
  }

  async review(context = {}) {
    assertSafeExecutionRequest(context);
    const safe = assertExecutionContext({ ...context, executor: this.mode });
    if (!context.runtime || typeof context.runtime.getFormReviewState !== 'function') {
      throw new Error('PlaywrightExecutor review requires a form-review capable browser runtime.');
    }
    const adapter = this.adapterResolver(safe.url);
    // Staged/uploaded resume file names let the runtime recognize an uploader
    // widget that consumed its input: the page showing the exact file name is
    // the honest "attached" evidence, so 上传简历附件 stops haunting the
    // checklist after a confirmed upload.
    const staged = context.staged_resume || safe.staged_resume || {};
    const uploadedFileNames = [staged.pdf_path, staged.docx_path]
      .filter(Boolean)
      .map(filePath => String(filePath).split(/[\\/]/).pop())
      .filter(Boolean);
    const [fields, pageState] = await Promise.all([
      context.runtime.getFormReviewState({ uploadedFileNames }),
      context.runtime.getPageState()
    ]);
    const plans = adapter.map_fields(fields, {
      profile: approvedFieldProfile(safe),
      profile_confirmed: true,
      minimum_confidence: context.minimum_confidence || 0.8,
      site_rules: confirmedSessionRules(safe, safe.url, context.field_memory || {}, fields),
      field_memory: context.field_memory || {},
      sensitive_reuse_categories: Array.isArray(safe.sensitive_reuse_categories) ? safe.sensitive_reuse_categories : []
    });
    const planByRef = new Map(plans.map(plan => [plan.field?.field_ref, plan]));
    // A radio/checkbox GROUP is answered when ANY of its options is selected.
    // Without this, every unselected option of an answered group counted as a
    // required-empty field and review completion could never be reached.
    const groupHasSelection = new Map();
    for (const field of fields) {
      if (!['radio', 'checkbox'].includes(field.type)) continue;
      const key = field.group_key || field.field_ref;
      groupHasSelection.set(key, Boolean(groupHasSelection.get(key)) || field.filled === true);
    }
    const effectiveFilled = field => ['radio', 'checkbox'].includes(field.type)
      ? Boolean(groupHasSelection.get(field.group_key || field.field_ref)) || field.filled === true
      : field.filled === true;
    const reviewFields = fields
      .filter(field => field.visible && !field.disabled && field.type !== 'hidden')
      .map(field => {
        const plan = planByRef.get(field.field_ref);
        const prohibited = ['password', 'file', 'submit', 'button', 'reset', 'image'].includes(field.type);
        const classification = field.type === 'file'
          ? 'file_upload'
          : prohibited
            ? 'protected'
            : plan?.action === 'fill'
              ? String(plan.mapping?.key || 'known_safe_field')
              : 'unknown';
        const sensitive = plan?.reason === 'skipped_sensitive';
        // The question engine's verdict for this control. DERIVED marks values
        // the ApplicationProfile projection computed from approved facts
        // (name split, current company/role, education span…).
        const DERIVED_KEYS = new Set(['first_name', 'last_name', 'current_company', 'current_title', 'graduation_date', 'years_experience', 'location', 'city', 'country']);
        const mappedSource = String(plan?.mapping?.source || '');
        const questionClass = (field.type === 'file' || prohibited || plan?.reason === 'skipped_captcha_control' || plan?.reason === 'skipped_submit')
          ? 'MANUAL_ONLY'
          : sensitive
            ? 'ASK_EVERY_TIME'
            : plan?.action === 'fill'
              ? (['confirmed_answer_memory', 'answer_memory', 'confirmed_form_field_memory'].includes(mappedSource)
                  ? 'ANSWER_MEMORY'
                  : DERIVED_KEYS.has(String(plan?.mapping?.key || '')) ? 'DERIVED' : 'PROFILE_KNOWN')
              : 'ASK_ONCE';
        return {
          field_ref: field.field_ref,
          label: field.label,
          // One question identity across wordings/sites, and one entry per
          // radio/checkbox GROUP (group_key) instead of one per option.
          // questionEquivalenceKey wants >=2 meaningful tokens; single-word
          // labels (Country*, Gender*) fall back to plain normalized text so
          // twin controls for one visible question still merge.
          normalized_question: questionEquivalenceKey(field.label || field.name || '')
            || String(field.label || field.name || '').toLocaleLowerCase('en-US')
              .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim(),
          group_key: field.group_key || field.field_ref,
          group_label: field.group_label || '',
          adapter: adapter.id,
          type: field.type,
          required: field.required,
          filled: effectiveFilled(field),
          options: Array.isArray(field.options) ? field.options.slice(0, 60) : [],
          // The unified mapper's verdict for this exact control: which profile
          // key it corresponds to, where that rule came from, how confident it
          // is, and whether the question is sensitive (never auto-filled).
          mapped_key: plan?.mapping?.key || '',
          source: plan?.mapping?.source || '',
          confidence: Number.isFinite(Number(plan?.mapping?.confidence)) ? Number(plan.mapping.confidence) : null,
          sensitive,
          question_class: questionClass,
          status: effectiveFilled(field)
            ? 'filled'
            : plan?.action === 'fill'
              ? 'fillable'
              : sensitive
                ? 'needs_user_sensitive'
                : String(plan?.reason || (field.required ? 'needs_user' : 'optional')),
          classification,
          reason: effectiveFilled(field) ? 'completed' : String(plan?.reason || (field.required ? 'manual_review_required' : 'optional_unfilled'))
        };
      });
    // Adjacency fallback for label-less option clusters: a run of consecutive
    // radio/checkbox controls that share no name and no <legend> (Lever's
    // "How did you hear about us?" checkboxes) is ONE question. Without this,
    // ticking one option still leaves its siblings counted required-empty and
    // review completion can never be reached.
    let optionRun = null;
    for (const field of reviewFields) {
      const parsedRef = String(field.field_ref).match(/^(f\d+-)?field-(\d+)$/);
      const framePrefix = parsedRef?.[1] || '';
      const elementIndex = Number(parsedRef?.[2] || 0);
      const ungrouped = ['radio', 'checkbox'].includes(field.type) && field.group_key === field.field_ref;
      if (ungrouped && optionRun && optionRun.framePrefix === framePrefix
        && optionRun.type === field.type && elementIndex === optionRun.lastIndex + 1) {
        field.group_key = optionRun.key;
        optionRun.lastIndex = elementIndex;
        optionRun.members.push(field);
      } else if (ungrouped) {
        optionRun = { key: `${framePrefix}optgroup-${elementIndex}`, framePrefix, type: field.type, lastIndex: elementIndex, members: [field] };
        field.group_key = optionRun.key;
      } else {
        optionRun = null;
      }
      if (optionRun && optionRun.members.length > 1 && !optionRun.labelled) {
        optionRun.labelled = true;
      }
    }
    // A multi-member run gets a synthetic question label listing its options.
    const runsByKey = new Map();
    for (const field of reviewFields) {
      if (!String(field.group_key || '').includes('optgroup-')) continue;
      if (!runsByKey.has(field.group_key)) runsByKey.set(field.group_key, []);
      runsByKey.get(field.group_key).push(field);
    }
    for (const members of runsByKey.values()) {
      if (members.length < 2) continue;
      const summary = `Select an option: ${members.slice(0, 4).map(member => member.label).filter(Boolean).join(' / ')}${members.length > 4 ? ' …' : ''}`;
      for (const member of members) member.group_label = summary;
    }

    // Counts are per QUESTION, not per element: radio/checkbox options share
    // their group; other twin controls rendered for one visible question (a
    // combobox's visible input + its companion, same label) share their
    // normalized question text.
    const questionKeyOf = field => (['radio', 'checkbox'].includes(field.type)
      ? field.group_key
      : field.normalized_question || field.group_key) || field.field_ref;
    const groupedByKey = new Map();
    for (const field of reviewFields) {
      const key = questionKeyOf(field);
      const existing = groupedByKey.get(key);
      if (!existing) {
        groupedByKey.set(key, { ...field });
      } else {
        existing.required = existing.required || field.required;
        existing.filled = existing.filled || field.filled;
        if (existing.classification === 'unknown' && field.classification !== 'unknown') existing.classification = field.classification;
      }
    }
    const questionGroups = [...groupedByKey.values()];
    const requiredFields = questionGroups.filter(field => field.required && !['submit', 'button', 'reset', 'image'].includes(field.type));
    const requiredEmpty = requiredFields.filter(field => !field.filled);
    const unknownRequired = requiredEmpty.filter(field => field.classification === 'unknown' || field.classification === 'protected');
    const fileUploads = reviewFields.filter(field => field.type === 'file');
    const highRiskBlockers = [];
    if (pageState.application_form_accessible === false) {
      highRiskBlockers.push({ code: 'FORM_NOT_ACCESSIBLE', message: 'The application form is not currently accessible.' });
    }
    if (pageState.challenge_scope === 'active') {
      highRiskBlockers.push({ code: 'ACTIVE_CHALLENGE', message: 'Complete the visible verification manually, then re-scan.' });
    }
    if (pageState.has_password || pageState.has_otp) {
      highRiskBlockers.push({ code: 'LOGIN_REQUIRED', message: 'Authentication must be completed manually before review can finish.' });
    }
    if (requiredEmpty.some(field => field.type !== 'file')) {
      highRiskBlockers.push({ code: 'REQUIRED_FIELDS_INCOMPLETE', message: `${requiredEmpty.filter(field => field.type !== 'file').length} required field(s) are still empty.` });
    }
    if (unknownRequired.length) {
      highRiskBlockers.push({ code: 'REQUIRED_FIELD_UNKNOWN', message: `${unknownRequired.length} required field(s) still need a user decision.` });
    }
    if (fileUploads.some(field => field.required && !field.filled)) {
      highRiskBlockers.push({ code: 'FILE_UPLOAD_REQUIRED', message: 'A required file upload is still empty.' });
    }
    const submissionBlockers = [];
    // Invisible verification scaffolding with a fully accessible form is
    // informational, not a to-do — only a challenge somebody can SEE creates
    // a manual-completion blocker.
    if (pageState.challenge_scope === 'passive' && pageState.challenge?.any_visible !== false) {
      submissionBlockers.push('CAPTCHA_OR_VERIFICATION_REQUIRES_MANUAL_COMPLETION');
    }
    return {
      scan_id: String(context.scan_id || `review_rescan_${Date.now()}`),
      scanned_at: new Date().toISOString(),
      current_url: context.runtime.url || safe.url,
      detected_count: reviewFields.length,
      required_count: requiredFields.length,
      required_filled_count: requiredFields.filter(field => field.filled).length,
      required_empty_count: requiredEmpty.length,
      unknown_required_count: unknownRequired.length,
      file_upload_required: fileUploads.some(field => field.required),
      file_upload_present: fileUploads.some(field => field.filled),
      submit_control_detected: pageState.submit_control_detected === true,
      form_accessible: pageState.application_form_accessible !== false,
      challenge_scope: pageState.challenge_scope || 'none',
      high_risk_blockers: highRiskBlockers,
      submission_blockers: submissionBlockers,
      fields: reviewFields,
      candidate_values_recorded: false,
      final_submit_clicked: false,
      resume_upload_attempted: false
    };
  }
}
