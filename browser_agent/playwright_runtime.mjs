// The browser-side runtime the executor drives. All DOM knowledge lives here;
// mapping/safety/planning stay in the shared core.
//
// Frame model: forms on real ATS pages sometimes live inside an embedded
// iframe (Greenhouse embed boards, some Workable/SmartRecruiters setups).
// Every read/write therefore spans the main frame plus every ACCESSIBLE
// child frame (cross-origin frames that refuse evaluation are skipped
// honestly). Field references are stable across a scan/fill pair:
//   main frame   → field-N        (unchanged, backward compatible)
//   child frames → f<k>-field-N   (k = index in the accessible-frame list)
//   ARIA widgets → [f<k>-]aria-N  (READ-ONLY: locatorForFieldRef cannot
//                                  resolve them, so no write can ever target
//                                  one — they exist for review and learning)

// One selector and ONE serialized collector for every page read that feeds
// review or learning. Modern ATS forms (Ashby, Workday) render whole question
// groups as ARIA widgets — role=radio/checkbox/switch toggle buttons,
// div-comboboxes, contenteditable editors — which a plain
// input/textarea/select query never sees, so the user's answers on them were
// structurally invisible. The review scan and the learning snapshot MUST see
// the same page; two divergent walks is how option labels ended up reported
// as questions.
const REVIEW_CONTROL_SELECTOR = [
  'input', 'textarea', 'select',
  '[role="radio"]', '[role="checkbox"]', '[role="switch"]', '[role="combobox"]',
  '[aria-pressed="true"]', '[aria-pressed="false"]', '[contenteditable="true"]',
].join(', ');

// Serialized into the page by Playwright: must stay fully self-contained.
// uploadedFileNames: staged resume file names — an uploader widget (Ashby)
// consumes input.files, so the page DISPLAYING the exact file name is the
// remaining truthful evidence that the required file control is satisfied.
const collectControlsInPage = (elements, uploadedFileNames) => {
  let nativeCount = 0;
  let ariaCount = 0;
  const readText = node => ((node && node.textContent) || '').replace(/\s+/g, ' ').trim();
  const idListText = tokens => String(tokens || '')
    .split(/\s+/).filter(Boolean)
    .map(token => readText(document.getElementById(token)))
    .join(' ').trim();
  return elements.map((element) => {
    const tag = element.tagName.toLowerCase();
    const native = ['input', 'textarea', 'select'].includes(tag);
    // An ARIA wrapper around a real control would double-count it — the
    // native element inside carries the actual state.
    if (!native && element.querySelector('input, textarea, select')) return null;
    const role = (element.getAttribute('role') || '').toLowerCase();
    const ariaPressed = element.getAttribute('aria-pressed');
    const type = native
      ? String(element.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text')).toLowerCase()
      : role === 'radio' ? 'radio'
        : (role === 'checkbox' || role === 'switch' || ariaPressed !== null) ? 'checkbox'
          : element.getAttribute('contenteditable') === 'true' ? 'textarea'
            : 'text';
    const fieldRef = native ? `field-${++nativeCount}` : `aria-${++ariaCount}`;
    const id = element.id || '';
    const explicitLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrappingLabel = element.closest('label');
    let ancestorLabel = null;
    let ancestor = element.parentElement;
    for (let depth = 0; depth < 3 && ancestor && !ancestorLabel; depth += 1) {
      ancestorLabel = ancestor.querySelector('label, legend, [data-qa*="label"], [class*="label"]');
      ancestor = ancestor.parentElement;
    }
    const ownLabel = (readText(explicitLabel)
      || readText(wrappingLabel)
      || readText(ancestorLabel)
      || element.getAttribute('aria-label')
      || idListText(element.getAttribute('aria-labelledby'))
      || '').trim();
    const optionLike = ['radio', 'checkbox'].includes(type);
    // The QUESTION for an option control lives on its group (fieldset legend
    // or ARIA radiogroup), never on the option itself; without this the EEO
    // option text masqueraded as the question.
    let groupLabel = '';
    if (optionLike) {
      const groupElement = element.closest('fieldset, [role="radiogroup"], [role="group"]');
      if (groupElement) {
        groupLabel = (readText(groupElement.querySelector('legend'))
          || groupElement.getAttribute('aria-label')
          || idListText(groupElement.getAttribute('aria-labelledby'))
          || '').trim();
        if (!groupLabel) {
          let walker = groupElement.parentElement;
          for (let depth = 0; depth < 3 && walker && !groupLabel; depth += 1) {
            const nearbyText = readText(walker.querySelector('label, legend, [data-qa*="label"], [class*="label"]'));
            if (nearbyText && nearbyText !== ownLabel) groupLabel = nearbyText;
            walker = walker.parentElement;
          }
        }
      }
    }
    const optionLabel = optionLike
      ? (native ? ownLabel : (element.getAttribute('aria-label') || readText(element)).trim()).slice(0, 300)
      : '';
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    const checked = native
      ? Boolean(element.checked)
      : (element.getAttribute('aria-checked') === 'true' || ariaPressed === 'true');
    // display_value is the human answer (option text, selected option label);
    // value keeps the raw control value for native elements.
    let value = '';
    let displayValue = '';
    if (native) {
      value = String(element.value || '');
      if (tag === 'select') {
        const selected = element.selectedIndex >= 0 ? element.options[element.selectedIndex] : null;
        displayValue = value.trim() ? (readText(selected) || value) : '';
      } else if (optionLike) {
        displayValue = checked ? (optionLabel || value || 'selected') : '';
      } else {
        displayValue = value;
      }
    } else if (optionLike) {
      displayValue = checked ? (optionLabel || 'selected') : '';
      value = displayValue;
    } else {
      displayValue = readText(element).slice(0, 5000);
      value = displayValue;
    }
    let filled = false;
    if (type === 'file') {
      filled = Boolean(element.files && element.files.length > 0)
        || (Array.isArray(uploadedFileNames) && uploadedFileNames.some(name =>
          name && (document.body?.innerText || '').includes(name)));
    } else if (optionLike) filled = checked;
    else filled = String(displayValue).trim() !== '';
    const questionLabel = optionLike ? (groupLabel || ownLabel) : ownLabel;
    return {
      field_ref: fieldRef,
      native,
      tag,
      type,
      name: element.getAttribute('name') || '',
      id,
      question_label: questionLabel.replace(/\s+/g, ' ').trim().slice(0, 300),
      own_label: ownLabel.replace(/\s+/g, ' ').trim().slice(0, 300),
      option_label: optionLabel,
      group_label: (groupLabel || '').slice(0, 300),
      placeholder: element.getAttribute('placeholder') || '',
      autocomplete: element.getAttribute('autocomplete') || '',
      role,
      aria_autocomplete: element.getAttribute('aria-autocomplete') || '',
      aria_haspopup: element.getAttribute('aria-haspopup') || '',
      required: Boolean(element.required
        || element.getAttribute('aria-required') === 'true'
        || (optionLike && element.closest('fieldset, [role="radiogroup"], [role="group"]')?.getAttribute('aria-required') === 'true')),
      disabled: Boolean(native ? element.disabled : element.getAttribute('aria-disabled') === 'true'),
      read_only: Boolean(native ? element.readOnly : false),
      visible,
      checked,
      filled,
      file_selected: type === 'file' && filled,
      value,
      display_value: displayValue,
      options: tag === 'select'
        ? Array.from(element.options).map(option => ({
            value: option.value,
            label: (option.textContent || '').trim(),
          })).filter(option => option.value || option.label).slice(0, 60)
        : optionLike
          ? [{ value: (native ? element.value : optionLabel) || '', label: optionLabel }]
          : [],
    };
  }).filter(Boolean);
};

export class PlaywrightPageRuntime {
  constructor(page) {
    this.page = page;
  }

  get url() {
    return this.page.url();
  }

  // Main frame first, then accessible child frames in a stable order.
  async accessibleFrames() {
    const main = this.page.mainFrame();
    const frames = [main];
    for (const frame of this.page.frames()) {
      if (frame === main) continue;
      try {
        await frame.evaluate(() => true);
        frames.push(frame);
      } catch {
        // Cross-origin or dying frame: unreadable, skip rather than guess.
      }
    }
    return frames;
  }

  frameRefPrefix(frameIndex) {
    return frameIndex === 0 ? '' : `f${frameIndex}-`;
  }

  // field_ref → { frameIndex, elementIndex } (both 0-based element index).
  parseFieldRef(fieldRef) {
    const match = String(fieldRef || '').match(/^(?:f(\d+)-)?field-(\d+)$/);
    if (!match) return null;
    return { frameIndex: Number(match[1] || 0), elementIndex: Number(match[2]) - 1 };
  }

  async locatorForFieldRef(fieldRef) {
    const parsed = this.parseFieldRef(fieldRef);
    if (!parsed || parsed.elementIndex < 0) return null;
    const frames = await this.accessibleFrames();
    const frame = frames[parsed.frameIndex];
    if (!frame) return null;
    return { frame, locator: frame.locator('input, textarea, select').nth(parsed.elementIndex) };
  }

  async getFields() {
    const frames = await this.accessibleFrames();
    const collected = [];
    for (const [frameIndex, frame] of frames.entries()) {
      const prefix = this.frameRefPrefix(frameIndex);
      let fields = [];
      try {
        fields = await frame.locator('input, textarea, select').evaluateAll((elements) => elements.map((element, index) => {
          const id = element.id || '';
          const explicitLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
          const wrappingLabel = element.closest('label');
          // Look outward through the field's container, not just the immediate
          // parent: ATS markup routinely nests the input a level or two below
          // the element that carries its label.
          let ancestorLabel = null;
          let ancestor = element.parentElement;
          for (let depth = 0; depth < 3 && ancestor && !ancestorLabel; depth += 1) {
            ancestorLabel = ancestor.querySelector('label, legend, [data-qa*="label"], [class*="label"]');
            ancestor = ancestor.parentElement;
          }
          // aria-labelledby / aria-label are how modern React-based forms name
          // their controls.
          const labelledBy = (element.getAttribute('aria-labelledby') || '')
            .split(/\s+/).filter(Boolean)
            .map(token => document.getElementById(token)?.textContent || '')
            .join(' ')
            .trim();
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const fieldType = String(element.getAttribute('type') || (element.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text')).toLowerCase();
          const ownLabel = (explicitLabel?.textContent
            || wrappingLabel?.textContent
            || ancestorLabel?.textContent
            || element.getAttribute('aria-label')
            || labelledBy
            || '').trim();
          // A radio/checkbox usually carries only its option text; the question
          // lives in the group's <legend>. Both matter: the question for
          // mapping, the option text for value matching.
          const legend = ['radio', 'checkbox'].includes(fieldType)
            ? (element.closest('fieldset')?.querySelector('legend')?.textContent || '').trim()
            : '';
          return {
            field_ref: `field-${index + 1}`,
            tag: element.tagName.toLowerCase(),
            type: fieldType,
            name: element.getAttribute('name') || '',
            id,
            label: legend && legend !== ownLabel ? `${legend} ${ownLabel}`.trim() : ownLabel,
            group_label: legend,
            placeholder: element.getAttribute('placeholder') || '',
            autocomplete: element.getAttribute('autocomplete') || '',
            role: element.getAttribute('role') || '',
            aria_autocomplete: element.getAttribute('aria-autocomplete') || '',
            aria_haspopup: element.getAttribute('aria-haspopup') || '',
            has_list: Boolean(element.getAttribute('list')),
            disabled: Boolean(element.disabled),
            read_only: Boolean(element.readOnly),
            required: Boolean(element.required || element.getAttribute('aria-required') === 'true'),
            visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
            // Choice controls surface their options so the shared planner can
            // verify a mapped value corresponds to a real option before
            // planning.
            options: element.tagName.toLowerCase() === 'select'
              ? Array.from(element.options).map(option => ({
                  value: option.value,
                  label: (option.textContent || '').trim()
                })).slice(0, 200)
              : ['radio', 'checkbox'].includes(fieldType)
                ? [{ value: element.value || '', label: ownLabel }]
                : [],
          };
        }));
      } catch {
        continue; // the frame navigated away mid-scan; skip it honestly
      }
      for (const field of fields) collected.push({ ...field, field_ref: `${prefix}${field.field_ref}` });
    }
    return collected;
  }

  async getPageState() {
    const state = await this.page.evaluate(() => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const controls = Array.from(document.querySelectorAll('input, textarea, select'));
      const accessibleApplicationControls = controls.filter((element) => {
        const type = String(element.getAttribute('type') || 'text').toLowerCase();
        // A visible file input IS the application form: resume-upload wizard
            // steps often hold nothing else. Password stays excluded — a login
            // wall is not an application form.
            return isVisible(element) && !element.disabled && !['hidden', 'submit', 'button', 'reset', 'image', 'password'].includes(type);
      });
      const form = document.querySelector('form');
      const challengeSelectors = [
        'iframe[src*="captcha" i]', 'iframe[src*="recaptcha" i]', 'iframe[src*="hcaptcha" i]',
        'iframe[src*="turnstile" i]', '[class*="captcha" i]', '[id*="captcha" i]', '[data-sitekey]',
        'textarea[name="g-recaptcha-response"]', 'textarea[name="h-captcha-response"]', 'input[name*="captcha" i]'
      ];
      const challengeNodes = [];
      const seen = new Set();
      for (const selector of challengeSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element)) continue;
          seen.add(element);
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const visible = isVisible(element);
          const coverage = window.innerWidth && window.innerHeight
            ? (rect.width * rect.height) / (window.innerWidth * window.innerHeight)
            : 0;
          challengeNodes.push({
            classifier: `selector=${selector};tag=${element.tagName.toLowerCase()};visible=${visible};inside_form=${Boolean(form && form.contains(element))}`,
            visible,
            overlay: visible && ['fixed', 'sticky'].includes(style.position) && coverage >= 0.5,
          });
        }
      }
      const bodyText = String(document.body?.innerText || '');
      // Some SPA portals (Ashby among them) render the application without a
      // <form> element at all. A page presenting several fillable controls IS
      // an accessible application form, tag or no tag.
      const applicationFormAccessible = Boolean(form && isVisible(form) && accessibleApplicationControls.length > 0)
        || accessibleApplicationControls.length >= 3;
      const activeInterstitialText = /(?:checking your browser|verify you are human|security verification|complete the security check|cloudflare)/i.test(bodyText.slice(0, 3000));
      return {
        url: location.href,
        title: document.title || '',
        text: bodyText.slice(0, 5000),
        has_password: Boolean(document.querySelector('input[type="password"]')),
        has_otp: Boolean(document.querySelector('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]')),
        accessible_application_control_count: accessibleApplicationControls.length,
        application_form_accessible: applicationFormAccessible,
        submit_control_detected: Boolean(document.querySelector('button[type="submit"], input[type="submit"], button:not([type])')),
        challenge_nodes: challengeNodes,
        active_interstitial_text: activeInterstitialText,
      };
    });

    // A form hidden inside an accessible child frame still counts as an
    // accessible application form — the main document alone proves nothing on
    // embed-style ATS pages.
    const frames = await this.accessibleFrames();
    for (const frame of frames.slice(1)) {
      try {
        const frameState = await frame.evaluate(() => {
          const isVisible = (element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const controls = Array.from(document.querySelectorAll('input, textarea, select')).filter((element) => {
            const type = String(element.getAttribute('type') || 'text').toLowerCase();
            // A visible file input IS the application form: resume-upload wizard
            // steps often hold nothing else. Password stays excluded — a login
            // wall is not an application form.
            return isVisible(element) && !element.disabled && !['hidden', 'submit', 'button', 'reset', 'image', 'password'].includes(type);
          });
          const form = document.querySelector('form');
          return {
            accessible_controls: controls.length,
            form_accessible: Boolean(form && isVisible(form) && controls.length > 0) || controls.length >= 3,
            has_password: Boolean(document.querySelector('input[type="password"]')),
            submit_control_detected: Boolean(document.querySelector('button[type="submit"], input[type="submit"], button:not([type])')),
          };
        });
        state.accessible_application_control_count += frameState.accessible_controls;
        state.application_form_accessible = state.application_form_accessible || frameState.form_accessible;
        state.has_password = state.has_password || frameState.has_password;
        state.submit_control_detected = state.submit_control_detected || frameState.submit_control_detected;
      } catch {
        // Frame became unreadable; the main-document verdict stands.
      }
    }

    const challengeNodes = state.challenge_nodes || [];
    const activeBlocking = challengeNodes.some(item => item.overlay)
      || (challengeNodes.some(item => item.visible) && !state.application_form_accessible)
      || (state.active_interstitial_text && !state.application_form_accessible);
    const challengePresent = challengeNodes.length > 0 || (state.active_interstitial_text && !state.application_form_accessible);
    const scope = challengePresent ? (activeBlocking ? 'active' : 'passive') : 'none';
    return {
      url: state.url,
      title: state.title,
      text: state.text,
      has_password: state.has_password,
      has_otp: state.has_otp,
      has_challenge: challengePresent,
      accessible_application_control_count: state.accessible_application_control_count,
      application_form_accessible: state.application_form_accessible,
      submit_control_detected: state.submit_control_detected,
      challenge_scope: scope,
      challenge: {
        present: challengePresent,
        active_blocking: activeBlocking,
        scope,
        // Hidden reCAPTCHA scaffolding ships on many portals without ever
        // showing a challenge; whether any node is actually VISIBLE decides
        // if the user is told "complete it" or "one may appear at submit".
        any_visible: challengeNodes.some(item => item.visible === true),
        application_form_accessible: state.application_form_accessible,
        accessible_application_control_count: state.accessible_application_control_count,
        evidence: challengeNodes.map(item => item.classifier).slice(0, 20),
      },
    };
  }

  // Both review and learning read the page through the SAME collector — one
  // selector, one label walk, one value model — so the checklist and the
  // knowledge-base capture can never disagree about what is on the page.
  async collectReviewControls({ uploadedFileNames = [] } = {}) {
    const frames = await this.accessibleFrames();
    const collected = [];
    for (const [frameIndex, frame] of frames.entries()) {
      const prefix = this.frameRefPrefix(frameIndex);
      let fields = [];
      try {
        fields = await frame.locator(REVIEW_CONTROL_SELECTOR).evaluateAll(collectControlsInPage, uploadedFileNames);
      } catch {
        continue;
      }
      for (const field of fields) {
        collected.push({ ...field, field_ref: `${prefix}${field.field_ref}` });
      }
    }
    return collected;
  }

  // Current live value of one previously described NATIVE field. Read-only.
  async readFieldValue(fieldRef) {
    const resolved = await this.locatorForFieldRef(fieldRef);
    if (!resolved) return null;
    try { return await resolved.locator.inputValue(); } catch { return null; }
  }

  async getFormReviewState(options = {}) {
    const controls = await this.collectReviewControls(options);
    return controls.map(field => {
      const optionLike = ['radio', 'checkbox'].includes(field.type);
      const framePrefix = String(field.field_ref).match(/^(f\d+-)/)?.[1] || '';
      const label = optionLike && field.group_label && field.group_label !== field.option_label
        ? `${field.group_label} ${field.option_label}`.replace(/\s+/g, ' ').trim().slice(0, 300)
        : (field.question_label || field.own_label);
      return {
        field_ref: field.field_ref,
        tag: field.tag,
        type: field.type,
        name: field.name,
        id: field.id,
        label,
        group_label: field.group_label,
        option_label: field.option_label,
        placeholder: field.placeholder,
        autocomplete: field.autocomplete,
        role: field.role,
        aria_autocomplete: field.aria_autocomplete,
        aria_haspopup: field.aria_haspopup,
        required: field.required,
        disabled: field.disabled,
        read_only: field.read_only,
        visible: field.visible,
        filled: field.filled,
        file_selected: field.file_selected,
        options: field.options,
        // One group key per question: options that share a name or a group
        // label collapse to a single checklist entry instead of one per option.
        group_key: optionLike
          ? `${framePrefix}group-${field.name || field.group_label || field.field_ref}`
          : field.field_ref,
      };
    });
  }

  async getPrivateLearningSnapshot() {
    const controls = await this.collectReviewControls();
    const prohibitedTypes = new Set(['hidden', 'password', 'file', 'submit', 'reset', 'image']);
    return controls
      .filter(field => field.visible && !field.disabled && !field.read_only
        && !prohibitedTypes.has(field.type)
        && String(field.display_value || '').trim() !== '')
      .map(field => ({
        field_ref: field.field_ref,
        tag: field.tag,
        type: field.type,
        name: field.name,
        id: field.id,
        // The QUESTION is the label; the chosen option travels separately so
        // the knowledge base learns "Sponsorship? → No", never "No → on".
        label: field.question_label || field.own_label,
        option_label: field.option_label,
        group_label: field.group_label,
        placeholder: field.placeholder,
        autocomplete: field.autocomplete,
        disabled: field.disabled,
        read_only: field.read_only,
        visible: field.visible,
        value: String(field.display_value || '').slice(0, 5000),
      }));
  }

  // Every file input on the page (all accessible frames), with enough
  // surrounding context to decide whether it is the resume control. Hidden
  // inputs are included on purpose: Lever, Greenhouse and most drag-and-drop
  // widgets hide the real <input type=file> behind a styled button or drop
  // zone.
  async describeFileInputs() {
    const frames = await this.accessibleFrames();
    const collected = [];
    for (const [frameIndex, frame] of frames.entries()) {
      let inputs = [];
      try {
        inputs = await frame.locator('input[type="file"]').evaluateAll((elements) => elements.map((element, index) => {
          const id = element.id || '';
          const explicitLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
          const wrappingLabel = element.closest('label');
          // Walk outward and collect the text of small ancestors: the drop
          // zone or upload widget wrapping the input usually says "Resume/CV"
          // or "Attach cover letter" within a couple of levels. Large
          // ancestors are skipped — their text is the whole form and proves
          // nothing.
          const contextParts = [];
          let ancestor = element.parentElement;
          for (let depth = 0; depth < 4 && ancestor; depth += 1) {
            const ancestorText = String(ancestor.innerText || '').trim();
            if (ancestorText && ancestorText.length <= 260) contextParts.push(ancestorText);
            const aria = ancestor.getAttribute && (ancestor.getAttribute('aria-label') || '');
            if (aria) contextParts.push(aria);
            ancestor = ancestor.parentElement;
          }
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const files = element.files;
          return {
            file_input_index: index,
            name: element.getAttribute('name') || '',
            id,
            accept: element.getAttribute('accept') || '',
            multiple: Boolean(element.multiple),
            disabled: Boolean(element.disabled),
            visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
            label: (explicitLabel?.textContent || wrappingLabel?.textContent || element.getAttribute('aria-label') || '').trim(),
            context_text: contextParts.join(' \n ').slice(0, 800),
            current_file_name: files && files.length > 0 ? String(files[0].name || '') : '',
            current_file_size: files && files.length > 0 ? Number(files[0].size || 0) : 0,
          };
        }));
      } catch {
        continue;
      }
      for (const input of inputs) collected.push({ ...input, frame_index: frameIndex });
    }
    return collected;
  }

  // Attach the staged resume to the page's resume control and verify it really
  // landed. Returns a structured result and NEVER claims success on the
  // strength of "the action ran": confirmation requires the input to actually
  // hold the file (or, if the site's JS swallowed the input, the page to show
  // the file name).
  async attachResume({ files = [], format_preference = 'auto' } = {}) {
    const RESUME_WORDS = /\b(resume|r[eé]sum[eé]|curriculum\s+vitae|cv)\b|简历|履歴書/i;
    const OTHER_DOC_WORDS = /\b(cover\s*_?letter|coverletter|transcript|portfolio|head\s*shot|headshot|avatar|profile\s+(?:photo|picture)|writing\s+sample)\b|求职信|照片/i;
    const available = files.filter(file => file && file.path && file.format);
    if (available.length === 0) {
      return { status: 'UPLOAD_FAILED', reason: 'No exported resume file was staged for this job.' };
    }

    let controls;
    try {
      controls = await this.describeFileInputs();
    } catch (error) {
      return { status: 'UPLOAD_FAILED', reason: `The page's file inputs could not be read: ${String(error?.message || error)}` };
    }
    const usable = controls.filter(control => !control.disabled);
    if (usable.length === 0) {
      return { status: 'UPLOAD_CONTROL_NOT_FOUND', reason: 'The page has no enabled file input.', controls_seen: controls.length };
    }

    const contextOf = (control) => [control.name, control.id, control.label, control.context_text].join(' ');
    const resumeControls = usable.filter(control => RESUME_WORDS.test(contextOf(control)));
    const neutralControls = usable.filter(control => {
      const context = contextOf(control);
      return !RESUME_WORDS.test(context) && !OTHER_DOC_WORDS.test(context);
    });
    // Prefer an explicit resume control; fall back to a lone neutral input
    // (single-upload forms often label the drop zone outside our 4-level
    // walk). Never fall back onto a control that says it wants a different
    // document.
    let chosen = null;
    if (resumeControls.length > 0) {
      chosen = resumeControls.find(control => control.visible) || resumeControls[0];
    } else if (usable.length === 1 && neutralControls.length === 1) {
      chosen = neutralControls[0];
    }
    if (!chosen) {
      return {
        status: 'UPLOAD_CONTROL_NOT_FOUND',
        reason: resumeControls.length === 0 && usable.length > 1
          ? 'Multiple file inputs exist and none is identifiable as the resume control.'
          : 'No file input on this page is identifiable as the resume control.',
        controls_seen: usable.map(control => ({ name: control.name, id: control.id, label: control.label.slice(0, 80), accept: control.accept })),
      };
    }

    // Pick the format. "auto" follows the control's accept list (PDF first);
    // an explicit preference is honoured only if the control accepts it.
    const acceptList = String(chosen.accept || '').toLowerCase();
    const acceptsFormat = (format) => {
      if (!acceptList.trim()) return true;
      if (format === 'pdf') return /(\.pdf|application\/pdf)/.test(acceptList);
      return /(\.docx?|officedocument\.wordprocessingml|application\/msword)/.test(acceptList);
    };
    const order = format_preference === 'docx' ? ['docx', 'pdf']
      : format_preference === 'pdf' ? ['pdf', 'docx']
      : ['pdf', 'docx'];
    let file = null;
    for (const format of order) {
      const candidate = available.find(item => item.format === format);
      if (candidate && acceptsFormat(format)) { file = candidate; break; }
    }
    if (!file) {
      return {
        status: 'FILE_TYPE_REJECTED',
        reason: `The resume control accepts "${chosen.accept}" and none of the staged formats (${available.map(item => item.format).join(', ')}) match.`,
        control: { name: chosen.name, id: chosen.id, accept: chosen.accept },
      };
    }

    const fileName = String(file.name || '').trim() || null;
    const frames = await this.accessibleFrames();
    const controlFrame = frames[chosen.frame_index || 0] || this.page.mainFrame();
    const locator = controlFrame.locator('input[type="file"]').nth(chosen.file_input_index);
    // Same correct file already in the input (a previous attempt before a
    // pause): that is a confirmed state, not a re-upload.
    if (fileName && chosen.current_file_name === fileName && chosen.current_file_size > 0) {
      return {
        status: 'confirmed', already_uploaded: true,
        file: { name: fileName, format: file.format },
        control: { name: chosen.name, id: chosen.id, accept: chosen.accept, visible: chosen.visible },
        evidence: { input_holds_file: true, page_shows_file_name: await this.pageShowsText(fileName) },
      };
    }
    // Uploader widgets (Ashby) CONSUME the file — the input goes empty while
    // the page displays the uploaded file's name. Re-handing the file would
    // re-trigger the portal's own resume-parse autofill, which rewrites the
    // form under the user on every re-run. The page showing the exact staged
    // file name is confirmed evidence; never upload twice on top of it.
    if (fileName && await this.pageShowsText(fileName)) {
      return {
        status: 'confirmed', already_uploaded: true,
        file: { name: fileName, format: file.format },
        control: { name: chosen.name, id: chosen.id, accept: chosen.accept, visible: chosen.visible },
        evidence: { input_holds_file: false, page_shows_file_name: true },
      };
    }

    try {
      await locator.setInputFiles(file.path);
    } catch (error) {
      return {
        status: 'UPLOAD_FAILED',
        reason: `Setting the file on the resume control failed: ${String(error?.message || error)}`,
        control: { name: chosen.name, id: chosen.id, accept: chosen.accept },
      };
    }

    // Verification. The input holding the exact file is primary evidence; the
    // page displaying the file name is secondary (some widgets move the file
    // out of the input once their own uploader takes over).
    let inputHoldsFile = false;
    try {
      const held = await locator.evaluate((element) => ({
        name: element.files && element.files.length > 0 ? String(element.files[0].name || '') : '',
        size: element.files && element.files.length > 0 ? Number(element.files[0].size || 0) : 0,
      }));
      inputHoldsFile = held.name === fileName && held.size > 0;
    } catch {
      inputHoldsFile = false;
    }
    let pageShowsFileName = false;
    for (let attempt = 0; attempt < 6 && !pageShowsFileName; attempt += 1) {
      pageShowsFileName = await this.pageShowsText(fileName);
      if (!pageShowsFileName) await this.page.waitForTimeout(500);
    }
    if (!inputHoldsFile && !pageShowsFileName) {
      return {
        status: 'UPLOAD_NOT_CONFIRMED',
        reason: 'The file was handed to the control, but neither the input nor the page shows it afterwards.',
        file: { name: fileName, format: file.format },
        control: { name: chosen.name, id: chosen.id, accept: chosen.accept },
      };
    }
    return {
      status: 'confirmed',
      file: { name: fileName, format: file.format },
      control: { name: chosen.name, id: chosen.id, accept: chosen.accept, visible: chosen.visible },
      evidence: { input_holds_file: inputHoldsFile, page_shows_file_name: pageShowsFileName },
    };
  }

  // A combobox commits a value only when an option is chosen. Type the wanted
  // text, wait for the option list, click the one unambiguous match, then
  // verify a value really committed. Anything less is reported honestly as
  // requires-selection — never as filled.
  async commitComboboxValue(locator, wanted, frame = null) {
    const target = wanted.trim();
    if (!target) return 'skipped_requires_selection';
    await locator.scrollIntoViewIfNeeded();
    try {
      await locator.click();
      await locator.fill(target);
    } catch { return 'skipped_requires_selection'; }
    const normalized = target.toLowerCase();
    const optionScope = frame || this.page;
    let clicked = false;
    for (let attempt = 0; attempt < 6 && !clicked; attempt += 1) {
      await this.page.waitForTimeout(500);
      const options = optionScope.locator('[role="option"]:visible');
      const texts = await options.allTextContents().catch(() => []);
      const matches = texts
        .map((text, optionIndex) => ({ text: text.trim(), optionIndex }))
        .filter(item => item.text);
      const exact = matches.filter(item => item.text.toLowerCase() === normalized);
      const containing = matches.filter(item => {
        const lower = item.text.toLowerCase();
        return lower.includes(normalized) || normalized.includes(lower);
      });
      const chosen = exact[0] || (containing.length === 1 ? containing[0] : null);
      if (chosen) {
        try {
          await options.nth(chosen.optionIndex).click();
          clicked = true;
        } catch { /* the list re-rendered; try the next read */ }
      }
    }
    if (!clicked) {
      // Leave no half-typed text behind: an uncommitted combobox must look
      // untouched, not "filled".
      await locator.fill('').catch(() => {});
      return 'skipped_requires_selection';
    }
    const committed = (await locator.inputValue().catch(() => '')).trim();
    if (!committed) {
      await locator.fill('').catch(() => {});
      return 'skipped_requires_selection';
    }
    return true;
  }

  async pageShowsText(needle) {
    if (!needle) return false;
    const frames = await this.accessibleFrames();
    for (const frame of frames) {
      try {
        const found = await frame.evaluate(
          (text) => String(document.body?.innerText || '').includes(text),
          needle
        );
        if (found) return true;
      } catch {
        // Frame unreadable; keep looking.
      }
    }
    return false;
  }

  async fillField(field, value, plan = null) {
    const resolved = await this.locatorForFieldRef(field?.field_ref);
    if (!resolved) throw new Error('Invalid field reference.');
    const { frame, locator } = resolved;
    const current = await locator.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      type: String(element.getAttribute('type') || 'text').toLowerCase(),
      name: element.getAttribute('name') || '',
      id: element.id || '',
      disabled: Boolean(element.disabled),
      readOnly: Boolean(element.readOnly),
    })).catch(() => null);
    if (!current) return false;
    // The DOM may have changed between scan and fill (dynamic forms). The
    // element behind the reference must still be the control the plan
    // described — otherwise refuse rather than type into the wrong field.
    const described = plan?.field || field || {};
    const identityHolds = current.tag === String(described.tag || current.tag)
      && current.type === String(described.type || current.type)
      && (!described.name || current.name === described.name)
      && (!described.id || current.id === described.id);
    if (!identityHolds) return 'skipped_not_visible';
    if (current.disabled || current.readOnly || current.type === 'file') return false;
    if (['submit', 'button', 'image', 'reset', 'password'].includes(current.type)) return false;

    // Choice controls: only a plan that names a verified option (or requires a
    // combobox commit) may act, and every action is verified by reading the
    // control back. No plan → refuse, exactly as before.
    if (current.tag === 'select') {
      const option = plan?.option;
      if (!option || (!option.value && !option.label)) return false;
      await locator.scrollIntoViewIfNeeded();
      try {
        if (option.value) await locator.selectOption({ value: option.value });
        else await locator.selectOption({ label: option.label });
      } catch { return false; }
      const selected = await locator.inputValue().catch(() => '');
      return option.value ? selected === option.value : selected !== '';
    }
    if (current.type === 'radio' || current.type === 'checkbox') {
      if (!plan?.option) return false;
      await locator.scrollIntoViewIfNeeded();
      try { await locator.check(); } catch { return false; }
      return locator.evaluate(element => element.checked === true).catch(() => false);
    }
    if (plan?.combobox_commit_required) {
      return this.commitComboboxValue(locator, String(value || ''), frame);
    }
    await locator.scrollIntoViewIfNeeded();
    const target = String(value || '');
    await locator.fill(target);

    // React-controlled inputs can revert a programmatic value when their
    // onChange never fires, leaving the field visibly empty. Observed on a
    // live Greenhouse form. Retry once through the native setter with the
    // event chain React listens for.
    let actual = await locator.inputValue().catch(() => '');
    if (actual !== target) {
      await locator.evaluate((element, nextValue) => {
        const prototype = element instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(element, nextValue); else element.value = nextValue;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, target);
      actual = await locator.inputValue().catch(() => '');
    }

    // Report what is actually on the page, not what was attempted. A field the
    // product could not really set must show up as something the user still
    // has to do.
    return actual === target;
  }
}
