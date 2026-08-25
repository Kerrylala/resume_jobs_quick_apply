(function attachResumeJobsExecutorCore(root, factory) {
  const api = factory();
  root.ResumeJobsApplicationExecutorCore = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createExecutorCore() {
  "use strict";

  const SCHEMA_VERSION = "1.0";
  const EXECUTOR_MODES = Object.freeze({
    EXTENSION: "extension",
    BROWSER_AGENT: "local_browser_agent",
  });

  // Observed on a live Greenhouse form: "Do you have a legal right to work in
  // Canada if hired by …?" matched none of the original work-authorization
  // wording, so it was classified merely "unknown". That is unsafe: once the
  // user saves an answer to such a question it would be treated as an ordinary
  // reusable answer and auto-filled, instead of being asked every time.
  // Immigration status wording is therefore matched broadly here — these fields
  // are never auto-filled, only surfaced for the user to answer.
  const SENSITIVE_PATTERN = /(?:eeo|equal employment|gender|sex\b|race|ethnic|disab|veteran|military|religion|marital|sexual orientation|pronoun|date of birth|birth date|age\b|salary|compensation|pay expectation|sponsorship|sponsor(?:ship)? (?:now|in the future)|work authorization|authoriz(?:ed|ation) to work|authoris(?:ed|ation) to work|right to work|legally (?:able|entitled|authorized) to work|work permit|\bvisa\b|immigration|citizen|nationality|criminal|background check|drug test|medical|health|social security|ssn|government id|passport|legal attestation|certif(?:y|ication))/i;
  const CHALLENGE_CONTROL_PATTERN = /(?:captcha|recaptcha|hcaptcha|turnstile|human verification)/i;
  const AUTH_PATTERN = /(?:verification code|one[- ]time|otp\b|mfa\b|two[- ]factor|2fa\b|password|passcode|sign[ -]?in|log[ -]?in)/i;
  const SUBMIT_PATTERN = /(?:^|\b)(?:submit|send application|complete application|finish application|apply now)(?:\b|$)/i;

  const DEFAULT_FIELD_MAPPINGS = Object.freeze([
    { key: "full_name", aliases: ["full name", "name", "candidate name"], confidence: 0.98 },
    { key: "first_name", aliases: ["first name", "given name"], confidence: 0.98 },
    { key: "last_name", aliases: ["last name", "family name", "surname"], confidence: 0.98 },
    { key: "email", aliases: ["email", "email address"], confidence: 0.99 },
    { key: "phone", aliases: ["phone", "phone number", "mobile", "mobile number"], confidence: 0.98 },
    // Exact "city" fields prefer the bare city value; the composite location
    // string covers the broader "location" wording below.
    { key: "city", aliases: ["city"], confidence: 0.9 },
    { key: "country", aliases: ["country", "country of residence"], confidence: 0.9 },
    { key: "location", aliases: ["location", "current location", "city", "city and state"], confidence: 0.9 },
    { key: "preferred_name", aliases: ["preferred name", "preferred first name", "nickname"], confidence: 0.92 },
    { key: "school", aliases: ["school", "university", "college", "school name", "institution"], confidence: 0.88 },
    { key: "degree", aliases: ["degree", "highest degree", "education level", "highest level of education"], confidence: 0.85 },
    { key: "major", aliases: ["major", "field of study", "discipline", "area of study"], confidence: 0.88 },
    { key: "graduation_date", aliases: ["graduation date", "graduation year", "expected graduation", "expected graduation date"], confidence: 0.85 },
    { key: "years_experience", aliases: ["years of experience", "years of work experience", "years of professional experience", "total experience"], confidence: 0.85 },
    { key: "linkedin_url", aliases: ["linkedin", "linkedin url", "linkedin profile"], confidence: 0.98 },
    { key: "github_url", aliases: ["github", "github url", "github profile"], confidence: 0.98 },
    { key: "portfolio_url", aliases: ["portfolio", "portfolio url", "personal website", "website"], confidence: 0.95 },
    // Present on live Lever forms as "Current company" (name="org") and common
    // across ATS platforms. It is an ordinary non-sensitive fact the profile
    // already holds, so leaving it unmapped just made the user retype it.
    { key: "current_company", aliases: ["current company", "current employer", "company", "employer"], confidence: 0.9 },
    { key: "current_title", aliases: ["current title", "current role", "job title", "current position"], confidence: 0.9 },
  ]);

  const PORTAL_DEFINITIONS = Object.freeze({
    lever: Object.freeze({
      id: "lever",
      site_rules: Object.freeze([
        { key: "full_name", aliases: ["name", "full name"], confidence: 1, source: "lever_exact_rule" },
        { key: "email", aliases: ["email"], confidence: 1, source: "lever_exact_rule" },
        { key: "phone", aliases: ["phone"], confidence: 1, source: "lever_exact_rule" },
        { key: "location", aliases: ["current location", "location"], confidence: 0.98, source: "lever_exact_rule" },
        { key: "linkedin_url", aliases: ["linkedin"], confidence: 1, source: "lever_exact_rule" },
        { key: "github_url", aliases: ["github"], confidence: 1, source: "lever_exact_rule" },
        { key: "portfolio_url", aliases: ["portfolio", "website"], confidence: 0.98, source: "lever_exact_rule" },
      ]),
      never_fill: Object.freeze(["resume", "cover letter", "additional information", "diversity", "eeo"]),
    }),
    greenhouse: Object.freeze({
      id: "greenhouse",
      site_rules: Object.freeze([
        { key: "first_name", aliases: ["first name", "first_name"], confidence: 1, source: "greenhouse_exact_rule" },
        { key: "last_name", aliases: ["last name", "last_name"], confidence: 1, source: "greenhouse_exact_rule" },
        { key: "email", aliases: ["email"], confidence: 1, source: "greenhouse_exact_rule" },
        { key: "phone", aliases: ["phone"], confidence: 1, source: "greenhouse_exact_rule" },
        { key: "location", aliases: ["location", "current location"], confidence: 0.95, source: "greenhouse_exact_rule" },
        { key: "linkedin_url", aliases: ["linkedin"], confidence: 1, source: "greenhouse_exact_rule" },
        { key: "github_url", aliases: ["github"], confidence: 1, source: "greenhouse_exact_rule" },
        { key: "portfolio_url", aliases: ["portfolio", "website"], confidence: 0.98, source: "greenhouse_exact_rule" },
      ]),
      never_fill: Object.freeze(["resume", "cover letter", "demographic", "diversity", "eeo", "voluntary self-identification"]),
    }),
    ashby: Object.freeze({
      id: "ashby",
      site_rules: Object.freeze([
        { key: "full_name", aliases: ["name", "full name"], confidence: 0.99, source: "ashby_exact_rule" },
        { key: "email", aliases: ["email"], confidence: 1, source: "ashby_exact_rule" },
        { key: "phone", aliases: ["phone"], confidence: 0.99, source: "ashby_exact_rule" },
        { key: "location", aliases: ["location", "current location"], confidence: 0.95, source: "ashby_exact_rule" },
        { key: "linkedin_url", aliases: ["linkedin"], confidence: 1, source: "ashby_exact_rule" },
        { key: "github_url", aliases: ["github"], confidence: 1, source: "ashby_exact_rule" },
        { key: "portfolio_url", aliases: ["portfolio", "website"], confidence: 0.98, source: "ashby_exact_rule" },
      ]),
      never_fill: Object.freeze(["resume", "cover letter", "demographic", "diversity", "eeo"]),
    }),
    smartrecruiters: Object.freeze({
      id: "smartrecruiters",
      site_rules: Object.freeze([
        { key: "first_name", aliases: ["first name", "firstname"], confidence: 1, source: "smartrecruiters_exact_rule" },
        { key: "last_name", aliases: ["last name", "lastname"], confidence: 1, source: "smartrecruiters_exact_rule" },
        { key: "email", aliases: ["email", "e-mail"], confidence: 1, source: "smartrecruiters_exact_rule" },
        { key: "phone", aliases: ["phone", "phone number"], confidence: 1, source: "smartrecruiters_exact_rule" },
        { key: "location", aliases: ["location", "city", "current location"], confidence: 0.95, source: "smartrecruiters_exact_rule" },
        { key: "linkedin_url", aliases: ["linkedin"], confidence: 1, source: "smartrecruiters_exact_rule" },
        { key: "portfolio_url", aliases: ["website", "portfolio"], confidence: 0.98, source: "smartrecruiters_exact_rule" },
      ]),
      never_fill: Object.freeze(["resume", "cover letter", "avatar", "photo", "diversity", "eeo"]),
    }),
    workable: Object.freeze({
      id: "workable",
      site_rules: Object.freeze([
        { key: "first_name", aliases: ["first name", "firstname"], confidence: 1, source: "workable_exact_rule" },
        { key: "last_name", aliases: ["last name", "lastname"], confidence: 1, source: "workable_exact_rule" },
        { key: "email", aliases: ["email", "e-mail"], confidence: 1, source: "workable_exact_rule" },
        { key: "phone", aliases: ["phone", "phone number"], confidence: 1, source: "workable_exact_rule" },
        { key: "location", aliases: ["address", "location", "city", "current location"], confidence: 0.92, source: "workable_exact_rule" },
        { key: "linkedin_url", aliases: ["linkedin"], confidence: 1, source: "workable_exact_rule" },
        { key: "portfolio_url", aliases: ["website", "portfolio"], confidence: 0.98, source: "workable_exact_rule" },
      ]),
      never_fill: Object.freeze(["resume", "cover letter", "avatar", "photo", "diversity", "eeo"]),
    }),
    generic: Object.freeze({
      id: "generic",
      site_rules: Object.freeze([]),
      never_fill: Object.freeze(["resume", "cover letter", "upload", "attachment", "diversity", "eeo"]),
    }),
  });

  function cleanText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function normalizedText(value) {
    return cleanText(value)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u2010-\u2015]/g, "-")
      .replace(/[^\p{L}\p{N}+#@./ -]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeExecutorMode(value) {
    return value === EXECUTOR_MODES.BROWSER_AGENT || value === "browser_agent"
      ? EXECUTOR_MODES.BROWSER_AGENT
      : EXECUTOR_MODES.EXTENSION;
  }

  function safeUrl(value) {
    try {
      return new URL(String(value || ""));
    } catch {
      return null;
    }
  }

  function detectPortal(value) {
    const url = safeUrl(value);
    const host = String(url && url.hostname || "").toLowerCase();
    if (host === "jobs.lever.co" || host.endsWith(".jobs.lever.co")) return "lever";
    if (host === "boards.greenhouse.io" || host.endsWith(".greenhouse.io")) return "greenhouse";
    if (host === "jobs.ashbyhq.com" || host.endsWith(".ashbyhq.com")) return "ashby";
    return "generic";
  }

  function isApplicationPage(value, expectedPortal) {
    const url = safeUrl(value);
    if (!url) return false;
    const portal = expectedPortal || detectPortal(url.href);
    const segments = url.pathname.split("/").filter(Boolean);
    if (portal === "lever") return segments.length >= 3 && segments[segments.length - 1].toLowerCase() === "apply";
    if (portal === "greenhouse") return Boolean(url.searchParams.get("gh_jid")) || /\/jobs\//i.test(url.pathname) || /\/embed\/job_app/i.test(url.pathname);
    if (portal === "ashby") return segments.length >= 2 && !/\b(?:privacy|terms)\b/i.test(url.pathname);
    return url.protocol === "http:" || url.protocol === "https:";
  }

  function portalDefinition(value) {
    const id = PORTAL_DEFINITIONS[value] ? value : detectPortal(value);
    return PORTAL_DEFINITIONS[id] || PORTAL_DEFINITIONS.generic;
  }

  function comparableExecutionUrl(value) {
    const url = safeUrl(value);
    if (!url) return "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    url.searchParams.sort();
    return url.href;
  }

  // A fragment that IS the SPA route ("#/job/123", "#!/apply/456") carries
  // application identity; a plain anchor ("#cv-fields") is cosmetic.
  function routeLikeFragment(url) {
    const hash = String(url.hash || "");
    if (hash.startsWith("#/")) return hash.slice(1);
    if (hash.startsWith("#!")) return hash.slice(2);
    return "";
  }

  // The searchable route of a URL: path + query + hash-route, split into
  // whole segments. Identity tokens must match these segments EXACTLY —
  // substring matching let job id 12345 "match" inside 2412345, and slug
  // "software-engineer" inside "software-engineer-apply-now".
  function routeSegments(url) {
    return `${url.pathname} ${url.search} ${routeLikeFragment(url)}`
      .toLowerCase()
      .split(/[/?&=#\s]+/)
      .filter(Boolean);
  }

  // The tokens that identify THIS application, extracted from the approved
  // URL's route. Only identifier-shaped segments qualify: a digit run of 5+
  // (job ids), a mixed segment containing digits (uuids, "7958409-role"),
  // or a long multi-hyphen role slug. Plain dictionary words ("marketing",
  // "engineer") and the tenant segment are NEVER identity — a shared word
  // must not put another company's or another role's form "in scope".
  function applicationIdentityTokens(url) {
    const segments = routeSegments(url);
    const pathSegments = url.pathname.toLowerCase().split("/").filter(Boolean);
    const tenantSegment = pathSegments[0] || "";
    const tokens = new Set();
    for (const segment of segments) {
      if (segment === tenantSegment) continue;
      if (/^\d{5,}$/.test(segment)) { tokens.add(segment); continue; }
      if (/\d/.test(segment) && /[a-z]/.test(segment) && segment.length >= 6) { tokens.add(segment); continue; }
      if ((segment.match(/-/g) || []).length >= 2 && segment.length >= 12) tokens.add(segment);
    }
    return Array.from(tokens);
  }

  // Multi-step applications walk through several URLs on the same host
  // (job page -> /jobs/apply/?id=... -> step pages). Strict URL equality
  // called every step "navigated away" and froze all assistance mid-wizard.
  // This scope rule is the definition of "the page the user approved", so it
  // fails CLOSED: same host AND same first path segment (the tenant on
  // shared ATS hosts like jobs.lever.co/<company>) AND, when the approved
  // URL carries identity tokens, one of them present as a WHOLE segment of
  // the current route. Without tokens, the approved path segments must be an
  // exact segment-prefix of the current path. A root approved URL never
  // widens scope.
  function withinApplicationScope(currentUrl, approvedUrl) {
    if (!currentUrl || !approvedUrl) return false;
    const current = safeUrl(currentUrl);
    const approved = safeUrl(approvedUrl);
    if (!current || !approved) return false;
    if (comparableExecutionUrl(currentUrl) === comparableExecutionUrl(approvedUrl)
      && routeLikeFragment(current) === routeLikeFragment(approved)) {
      return true;
    }
    if (current.hostname.toLowerCase() !== approved.hostname.toLowerCase()) return false;
    const currentPathSegments = current.pathname.toLowerCase().split("/").filter(Boolean);
    const approvedPathSegments = approved.pathname.toLowerCase().split("/").filter(Boolean);
    // Tenant pinning: the first path segment scopes the tenant on shared ATS
    // hosts; on single-tenant sites it is the section, equally worth pinning.
    if (approvedPathSegments.length > 0 && currentPathSegments[0] !== approvedPathSegments[0]) return false;
    const tokens = applicationIdentityTokens(approved);
    if (tokens.length) {
      const currentSegments = new Set(routeSegments(current));
      return tokens.some(function (token) { return currentSegments.has(token); });
    }
    // Token-less approved URL: segment-boundary prefix, never empty.
    if (approvedPathSegments.length === 0) return false;
    if (currentPathSegments.length < approvedPathSegments.length) return false;
    for (let index = 0; index < approvedPathSegments.length; index += 1) {
      if (currentPathSegments[index] !== approvedPathSegments[index]) return false;
    }
    return true;
  }

  function classifyPageSafety(page, approvedUrl) {
    const state = page && typeof page === "object" ? page : {};
    const currentUrl = cleanText(state.url || approvedUrl);
    if (approvedUrl && !withinApplicationScope(currentUrl, approvedUrl)) {
      return { action: "skip", reason: "approved_url_redirected", challenge_scope: "none", submission_blocker: "" };
    }
    const text = normalizedText([currentUrl, state.title, state.text].filter(Boolean).join(" "));
    const challenge = state.challenge && typeof state.challenge === "object" ? state.challenge : {};
    const challengePresent = Boolean(
      challenge.present || state.has_challenge || state.challenge_scope === "active" || state.challenge_scope === "passive"
    );
    const accessibleControls = Number(
      state.accessible_application_control_count ?? challenge.accessible_application_control_count ?? 0
    );
    const applicationFormAccessible = state.application_form_accessible === true || challenge.application_form_accessible === true;
    const explicitScope = cleanText(state.challenge_scope || challenge.scope).toLowerCase();
    const activeChallenge = challengePresent && (
      explicitScope === "active" || challenge.active_blocking === true ||
      (!explicitScope && !(applicationFormAccessible && accessibleControls > 0))
    );
    const passiveChallenge = challengePresent && !activeChallenge && (
      explicitScope === "passive" || (applicationFormAccessible && accessibleControls > 0)
    );
    const challengeEvidence = (Array.isArray(challenge.evidence) ? challenge.evidence : [])
      .map((item) => cleanText(typeof item === "string" ? item : item && item.classifier))
      .filter(Boolean)
      .slice(0, 20);
    if (activeChallenge) {
      return {
        action: "skip",
        reason: "active_challenge_blocks_form",
        challenge_scope: "active",
        submission_blocker: "CAPTCHA_REQUIRES_USER",
        evidence: challengeEvidence,
      };
    }
    if (passiveChallenge) {
      // Hidden verification scaffolding with a fully accessible form is not a
      // to-do: nothing is asked of the user yet. The imperative blocker is
      // reserved for a challenge somebody can actually SEE.
      const invisibleOnly = challenge.any_visible === false && applicationFormAccessible;
      return {
        action: "allow",
        reason: "passive_challenge_submission_only",
        challenge_scope: "passive",
        submission_blocker: invisibleOnly ? "CAPTCHA_MAY_APPEAR_AT_SUBMIT" : "CAPTCHA_REQUIRES_USER",
        evidence: challengeEvidence,
      };
    }
    if (state.has_otp || /verification code|one time code|\botp\b|\bmfa\b|two factor|2fa/.test(text)) {
      return { action: "skip", reason: "mfa_or_verification_detected", challenge_scope: "active", submission_blocker: "VERIFICATION_REQUIRES_USER" };
    }
    if (state.has_password || /\/(?:login|signin|sign-in)(?:\/|\?|$)/.test(text)) {
      return { action: "skip", reason: "login_detected", challenge_scope: "active", submission_blocker: "LOGIN_REQUIRES_USER" };
    }
    return { action: "allow", reason: "approved_application_page", challenge_scope: "none", submission_blocker: "" };
  }

  function normalizeFieldDescriptor(field, index) {
    const source = field && typeof field === "object" ? field : {};
    const tag = normalizedText(source.tag || source.tagName || "input");
    const type = normalizedText(source.type || (tag === "textarea" ? "textarea" : "text"));
    const label = cleanText(source.label || source.ariaLabel || source.placeholder || source.name || source.id);
    const descriptor = {
      field_ref: cleanText(source.field_ref || source.ref || source.selector || `field-${Number(index || 0) + 1}`),
      tag,
      type,
      name: cleanText(source.name),
      id: cleanText(source.id),
      label,
      placeholder: cleanText(source.placeholder),
      autocomplete: cleanText(source.autocomplete),
      disabled: Boolean(source.disabled),
      read_only: Boolean(source.read_only || source.readOnly),
      visible: source.visible !== false,
      required: Boolean(source.required),
      // A combobox looks like a text input but only commits a value when an
      // option is chosen. Typing into one filters the list and selects nothing,
      // so filling it would report success while leaving the field empty.
      combobox: Boolean(source.combobox)
        || normalizedText(source.role) === "combobox"
        || Boolean(source.aria_autocomplete)
        || normalizedText(source.aria_haspopup) === "listbox"
        || Boolean(source.has_list),
      // Choice controls (select options, a radio's own value, a checkbox's
      // value) carry their choices so the planner can verify a mapped value
      // actually corresponds to a real option before planning a selection.
      options: (Array.isArray(source.options) ? source.options : [])
        .map((option) => ({
          value: cleanText(option && typeof option === "object" ? option.value : option),
          label: cleanText(option && typeof option === "object" ? option.label : option),
        }))
        .filter((option) => option.value || option.label)
        .slice(0, 200),
    };
    descriptor.search_text = normalizedText([
      descriptor.label,
      descriptor.name,
      descriptor.id,
      descriptor.placeholder,
      descriptor.autocomplete,
    ].filter(Boolean).join(" "));
    return descriptor;
  }

  function classifyFieldSafety(field, options) {
    const descriptor = normalizeFieldDescriptor(field, 0);
    const settings = options && typeof options === "object" ? options : {};
    const text = descriptor.search_text;
    if (descriptor.type === "file") return { action: "skip", reason: "skipped_file_upload" };
    if (CHALLENGE_CONTROL_PATTERN.test(text)) return { action: "skip", reason: "skipped_captcha_control" };
    if (["submit", "button", "reset", "image"].includes(descriptor.type) || descriptor.tag === "button" || SUBMIT_PATTERN.test(text)) {
      return { action: "skip", reason: "skipped_submit" };
    }
    if (AUTH_PATTERN.test(text) || ["password"].includes(descriptor.type) || /one-time-code/i.test(descriptor.autocomplete)) {
      return { action: "skip", reason: "skipped_sensitive" };
    }
    // Sensitivity is judged BEFORE visibility: ATS widgets often back a
    // visible toggle-button question with a hidden input (Ashby's
    // work-authorization / sponsorship Yes-No). Reporting those as
    // "not visible" hid the sensitive question from the ask-the-user flow —
    // the honest classification is sensitive first, invisible second.
    if (SENSITIVE_PATTERN.test(text)) return { action: "review", reason: "skipped_sensitive" };
    if (!descriptor.visible || descriptor.type === "hidden" || descriptor.disabled || descriptor.read_only) {
      return { action: "skip", reason: "skipped_not_visible" };
    }
    const neverFill = Array.isArray(settings.never_fill) ? settings.never_fill : [];
    if (neverFill.some((pattern) => normalizedText(pattern) && text.includes(normalizedText(pattern)))) {
      return { action: "review", reason: "skipped_sensitive" };
    }
    if (["checkbox", "radio"].includes(descriptor.type) || descriptor.tag === "select") {
      return { action: "review", reason: "skipped_unknown" };
    }
    // Observed on a live Greenhouse form: the Location control is
    // role="combobox". Typing into it filtered the options without selecting
    // one, so the product would have reported the field filled while the form
    // still had no value for it.
    if (descriptor.combobox) {
      return { action: "review", reason: "skipped_requires_selection" };
    }
    return { action: "allow", reason: "safe_known_field" };
  }

  function leafValue(candidate) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && Object.prototype.hasOwnProperty.call(candidate, "value")) {
      return {
        value: candidate.value,
        source: cleanText(candidate.source || "career_brain"),
        confidence: Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : 0.95,
        user_confirmed: candidate.user_confirmed !== false,
        last_used: candidate.last_used || null,
      };
    }
    return {
      value: candidate,
      source: "career_brain",
      confidence: 0.95,
      user_confirmed: true,
      last_used: null,
    };
  }

  function getPath(source, path) {
    let current = source;
    for (const part of path.split(".")) {
      if (!current || typeof current !== "object" || !(part in current)) return undefined;
      current = current[part];
    }
    return current;
  }

  // Common two-character Chinese surnames; single-character surnames cover the
  // rest. Used only for unspaced CJK full names, where the family name comes
  // FIRST — the Western token order below would return the whole name for
  // both parts.
  const CJK_DOUBLE_SURNAMES = ["欧阳", "司马", "上官", "诸葛", "夏侯", "皇甫", "尉迟", "公孙", "令狐", "慕容", "司徒", "端木", "东方", "独孤", "南宫", "西门", "轩辕"];

  function splitName(profile, part) {
    const full = cleanText(
      getPath(profile, "full_name") ||
      getPath(profile, "identity.full_name") ||
      getPath(profile, "contact.full_name") ||
      getPath(profile, "name")
    );
    if (!full) return "";
    if (/^[㐀-鿿]{2,4}$/.test(full)) {
      const surnameLength = CJK_DOUBLE_SURNAMES.some((surname) => full.startsWith(surname)) ? 2 : 1;
      return part === "last_name" ? full.slice(0, surnameLength) : full.slice(surnameLength);
    }
    const pieces = full.split(/\s+/).filter(Boolean);
    return part === "first_name" ? pieces.slice(0, Math.max(1, pieces.length - 1)).join(" ") : pieces.slice(-1).join(" ");
  }

  function profileValue(profile, key) {
    const paths = {
      full_name: ["full_name", "identity.full_name", "identity.name", "contact.full_name", "name"],
      first_name: ["first_name", "identity.first_name", "contact.first_name"],
      last_name: ["last_name", "identity.last_name", "contact.last_name"],
      email: ["email", "contact.email", "identity.email"],
      phone: ["phone", "contact.phone", "identity.phone", "phone_number"],
      location: ["location", "current_location", "contact.location", "identity.location"],
      linkedin_url: ["linkedin_url", "linkedin", "contact.linkedin_url", "links.linkedin"],
      github_url: ["github_url", "github", "contact.github_url", "links.github"],
      portfolio_url: ["portfolio_url", "portfolio", "website", "contact.portfolio_url", "links.portfolio", "links.website"],
      current_company: [
        "current_company",
        "work_situation.current_company",
        "job_preferences.current_company",
        "company"
      ],
      current_title: [
        "current_title",
        "work_situation.current_title",
        "job_preferences.current_title",
        "title"
      ],
      preferred_name: ["preferred_name", "identity.preferred_name"],
      city: ["city", "identity.city"],
      country: ["country", "identity.country"],
      graduation_date: ["graduation_date", "graduation_year"],
    };
    for (const path of paths[key] || [key]) {
      const resolved = getPath(profile || {}, path);
      const leaf = leafValue(resolved);
      if (cleanText(leaf.value)) return leaf;
    }
    if (key === "first_name" || key === "last_name") {
      const value = splitName(profile || {}, key);
      // A split derived from full_name was never confirmed by the user and the
      // token order is ambiguous across cultures; it must not be treated as a
      // confirmed fact, so approved-mapping builders will exclude it.
      if (value) return { value, source: "career_brain:full_name", confidence: 0.6, user_confirmed: false, derived: true, last_used: null };
    }
    return { value: "", source: "career_brain", confidence: 0, user_confirmed: false, last_used: null };
  }

  function aliasMatches(searchText, alias) {
    const target = normalizedText(alias);
    if (!target) return false;
    if (searchText === target) return true;
    return searchText.includes(target) && (target.length >= 5 || searchText.split(" ").includes(target));
  }

  // The HTML autocomplete attribute is a standardized, unambiguous statement of
  // what a control wants. When a form sets it, it is a stronger signal than any
  // label guess — and it is the only signal on forms whose visible label lives
  // in an element we cannot associate.
  const AUTOCOMPLETE_KEYS = Object.freeze({
    name: "full_name",
    "given-name": "first_name",
    "family-name": "last_name",
    email: "email",
    tel: "phone",
    "tel-national": "phone",
    "address-level2": "location",
    "organization": "current_company",
    "organization-title": "current_title",
    url: "portfolio_url",
  });

  function autocompleteKey(descriptor) {
    const token = normalizedText(descriptor.autocomplete).split(/\s+/).pop();
    return AUTOCOMPLETE_KEYS[token] || "";
  }

  // The MOST SPECIFIC matching rule wins, not the first one. Observed on a
  // live Ashby form: "Current/Most Recent Company Name" contains the word
  // "name", so the first-listed full_name rule (alias "name") claimed it and
  // the candidate's NAME landed in the company field. Specificity = length of
  // the longest alias that matches; an HTML autocomplete token (a
  // standardized, unambiguous declaration) outranks every label guess; rule
  // order only breaks ties (site rules stay ahead of defaults).
  function fieldMapping(field, context) {
    const descriptor = normalizeFieldDescriptor(field, 0);
    const settings = context && typeof context === "object" ? context : {};
    const explicitRules = Array.isArray(settings.site_rules) ? settings.site_rules : [];
    const defaults = Array.isArray(settings.default_mappings) && settings.default_mappings.length
      ? settings.default_mappings
      : DEFAULT_FIELD_MAPPINGS;
    const autocompleteRule = autocompleteKey(descriptor)
      ? [{ key: autocompleteKey(descriptor), aliases: [], confidence: 0.97, source: "html_autocomplete", matchAll: true }]
      : [];
    const rules = explicitRules.concat(autocompleteRule, defaults);
    let best = null;
    for (const [order, rule] of rules.entries()) {
      let specificity = 0;
      if (rule.matchAll) {
        specificity = 1000; // autocomplete: standardized > any label heuristic
      } else {
        const aliases = Array.isArray(rule.aliases) ? rule.aliases : [rule.name, rule.label, rule.id].filter(Boolean);
        for (const alias of aliases) {
          if (aliasMatches(descriptor.search_text, alias)) {
            specificity = Math.max(specificity, normalizedText(alias).length);
          }
        }
        if (!specificity) continue;
      }
      const key = cleanText(rule.key || rule.profile_key);
      if (!key) continue;
      const resolved = profileValue(settings.profile || {}, key);
      if (!cleanText(resolved.value)) continue;
      if (best && best.specificity >= specificity) continue;
      best = {
        specificity,
        order,
        mapping: {
          key,
          value: cleanText(resolved.value),
          source: cleanText(rule.source || resolved.source || "career_brain"),
          confidence: Math.min(Number(rule.confidence || 1), Number(resolved.confidence || 1)),
          user_confirmed: resolved.user_confirmed !== false && settings.profile_confirmed !== false,
          last_used: resolved.last_used || null,
        },
      };
    }
    return best ? best.mapping : null;
  }

  function fieldMappingCandidate(field, context) {
    const descriptor = normalizeFieldDescriptor(field, 0);
    const settings = context && typeof context === "object" ? context : {};
    const explicitRules = Array.isArray(settings.site_rules) ? settings.site_rules : [];
    const defaults = Array.isArray(settings.default_mappings) && settings.default_mappings.length
      ? settings.default_mappings
      : DEFAULT_FIELD_MAPPINGS;
    for (const rule of explicitRules.concat(defaults)) {
      const aliases = Array.isArray(rule.aliases) ? rule.aliases : [rule.name, rule.label, rule.id].filter(Boolean);
      if (!aliases.some((alias) => aliasMatches(descriptor.search_text, alias))) continue;
      const key = cleanText(rule.key || rule.profile_key);
      if (key) return { key, rule };
    }
    return null;
  }

  // Does a mapped value correspond to one of a choice control's real options?
  // Exact value/label match first, then an unambiguous case-insensitive label
  // containment. Ambiguity or no match returns null — never a guess.
  function matchOptionForValue(options, value) {
    const wanted = normalizedText(value);
    if (!wanted || !Array.isArray(options) || options.length === 0) return null;
    const exact = options.find((option) => normalizedText(option.value) === wanted
      || normalizedText(option.label) === wanted);
    if (exact) return exact;
    const containing = options.filter((option) => {
      const label = normalizedText(option.label);
      return label && (label.includes(wanted) || wanted.includes(label));
    });
    return containing.length === 1 ? containing[0] : null;
  }

  const AFFIRMATIVE_VALUES = new Set(["yes", "true", "y", "1", "checked", "agree", "agreed", "accept", "accepted"]);

  function planField(field, context, index) {
    const descriptor = normalizeFieldDescriptor(field, index);
    const safety = classifyFieldSafety(descriptor, context && context.safety);
    // Choice controls (select / radio / checkbox / combobox) are safe to act on
    // only when an approved mapping's value provably corresponds to a real
    // option of the control. The safety classifier has already screened out
    // sensitive/auth/file/submit fields before reaching its choice-control
    // verdicts, so only those two verdicts may be upgraded here.
    if (safety.action === "review" && ["skipped_unknown", "skipped_requires_selection"].includes(safety.reason)) {
      const isSelect = descriptor.tag === "select";
      const isRadio = descriptor.type === "radio";
      const isCheckbox = descriptor.type === "checkbox";
      const isCombobox = descriptor.combobox && !isSelect && !isRadio && !isCheckbox;
      if (isSelect || isRadio || isCheckbox || isCombobox) {
        const mapping = fieldMapping(descriptor, context);
        const confident = mapping && mapping.user_confirmed
          && mapping.confidence >= Number(context && context.minimum_confidence || 0.8);
        if (confident && (isSelect || isRadio)) {
          const option = matchOptionForValue(descriptor.options, mapping.value);
          if (option) {
            return { field: descriptor, action: "fill", reason: "filled_safe_field", mapping, option };
          }
        }
        if (confident && isCheckbox) {
          // Only an affirmative confirmed value may tick a checkbox, and only
          // when the checkbox's own value/label corresponds. Never uncheck.
          if (AFFIRMATIVE_VALUES.has(normalizedText(mapping.value))
            || matchOptionForValue(descriptor.options, mapping.value)) {
            return { field: descriptor, action: "fill", reason: "filled_safe_field", mapping, option: { value: "checked", label: descriptor.label } };
          }
        }
        if (confident && isCombobox) {
          // The combobox's option list only exists after interaction; the plan
          // carries the intent and the executor must verify a committed value
          // (or report requires-selection honestly).
          return { field: descriptor, action: "fill", reason: "filled_safe_field", mapping, combobox_commit_required: true };
        }
      }
      return { field: descriptor, action: "skip", reason: safety.reason, mapping: null };
    }
    // Sensitive questions may auto-fill ONLY under the user's explicit
    // per-category 'reuse' policy, ONLY from an answer the user confirmed for
    // a QUESTION (confirmed answer/field memory — never identity defaults or
    // label guesses). Auth/captcha/file/submit controls are hard-skipped
    // earlier and can never reach this branch.
    if (safety.action === "review" && safety.reason === "skipped_sensitive") {
      const category = sensitiveQuestionCategory(descriptor.search_text);
      const reuseCategories = Array.isArray(context && context.sensitive_reuse_categories)
        ? context.sensitive_reuse_categories
        : [];
      if (category && reuseCategories.includes(category)) {
        const mapping = fieldMapping(descriptor, context);
        const confirmedQuestionAnswer = mapping && mapping.user_confirmed
          && ["confirmed_answer_memory", "confirmed_form_field_memory", "answer_memory"].includes(mapping.source)
          && mapping.confidence >= Number(context && context.minimum_confidence || 0.8);
        if (confirmedQuestionAnswer) {
          const isSelect = descriptor.tag === "select";
          const isRadio = descriptor.type === "radio";
          const isCheckbox = descriptor.type === "checkbox";
          const isCombobox = descriptor.combobox && !isSelect && !isRadio && !isCheckbox;
          if (isSelect || isRadio) {
            const option = matchOptionForValue(descriptor.options, mapping.value);
            if (option) return { field: descriptor, action: "fill", reason: "filled_sensitive_confirmed", mapping, option };
          } else if (isCheckbox) {
            if (AFFIRMATIVE_VALUES.has(normalizedText(mapping.value)) || matchOptionForValue(descriptor.options, mapping.value)) {
              return { field: descriptor, action: "fill", reason: "filled_sensitive_confirmed", mapping, option: { value: "checked", label: descriptor.label } };
            }
          } else if (isCombobox) {
            return { field: descriptor, action: "fill", reason: "filled_sensitive_confirmed", mapping, combobox_commit_required: true };
          } else {
            return { field: descriptor, action: "fill", reason: "filled_sensitive_confirmed", mapping };
          }
        }
      }
      return { field: descriptor, action: "skip", reason: "skipped_sensitive", mapping: null };
    }
    if (safety.action !== "allow") {
      return { field: descriptor, action: "skip", reason: safety.reason, mapping: null };
    }
    const mapping = fieldMapping(descriptor, context);
    if (!mapping) {
      return {
        field: descriptor,
        action: "skip",
        reason: fieldMappingCandidate(descriptor, context) ? "skipped_value_missing" : "skipped_unknown",
        mapping: null,
      };
    }
    if (!mapping.user_confirmed) return { field: descriptor, action: "skip", reason: "skipped_value_missing", mapping: null };
    if (mapping.confidence < Number(context && context.minimum_confidence || 0.8)) {
      return { field: descriptor, action: "skip", reason: "skipped_unknown", mapping: null };
    }
    // Found by the installed-mode acceptance: "Why do you want this specific
    // role at our company?" matched the identity alias "company" and would have
    // been filled with the employer name. An open-ended question — a textarea,
    // or a label that reads as a question — may only be answered from a value
    // the user explicitly confirmed for a question, never from identity
    // defaults or autocomplete guesses.
    const confirmedQuestionSources = ["confirmed_answer_memory", "confirmed_form_field_memory", "answer_memory"];
    const openQuestion = descriptor.tag === "textarea"
      || /\?\s*$/.test(descriptor.label)
      || /^\s*(?:why|describe|tell us|what|how did|how would|explain)\b/i.test(descriptor.label)
      || descriptor.label.length > 90;
    if (openQuestion && !confirmedQuestionSources.includes(mapping.source)) {
      return { field: descriptor, action: "skip", reason: "skipped_unknown", mapping: null };
    }
    return {
      field: descriptor,
      action: "fill",
      reason: mapping.key === "location" ? "requires_manual_location_confirmation" : "filled_safe_field",
      mapping,
    };
  }

  function planFields(fields, context) {
    return (Array.isArray(fields) ? fields : []).map((field, index) => planField(field, context || {}, index));
  }

  function sanitizeFieldResult(result, index) {
    const source = result && typeof result === "object" ? result : {};
    const field = normalizeFieldDescriptor(source.field || source, index);
    const outcome = ["filled", "skipped", "failed"].includes(source.outcome) ? source.outcome : "skipped";
    return {
      field_ref: field.field_ref,
      label: field.label || field.name || field.id || `Field ${Number(index || 0) + 1}`,
      type: field.type,
      mapping_key: cleanText(source.mapping_key || source.mapping && source.mapping.key),
      source: cleanText(source.source || source.mapping && source.mapping.source),
      confidence: Number.isFinite(Number(source.confidence || source.mapping && source.mapping.confidence))
        ? Number(source.confidence || source.mapping && source.mapping.confidence)
        : 0,
      outcome,
      reason: cleanText(source.reason || (outcome === "filled" ? "filled_safe_field" : "skipped_unknown")),
    };
  }

  function createApplicationExecution(input) {
    const data = input && typeof input === "object" ? input : {};
    const inputFields = Array.isArray(data.field_results)
      ? data.field_results
      : Array.isArray(data.fields)
        ? data.fields
        : data.fields && typeof data.fields === "object"
          ? [
            ...(Array.isArray(data.fields.filled) ? data.fields.filled : []),
            ...(Array.isArray(data.fields.skipped) ? data.fields.skipped : []),
            ...(Array.isArray(data.fields.failed) ? data.fields.failed : []),
          ]
          : [];
    const fields = inputFields.map(sanitizeFieldResult);
    const filled = fields.filter((entry) => entry.outcome === "filled").length;
    const skipped = fields.filter((entry) => entry.outcome === "skipped").length;
    const failed = fields.filter((entry) => entry.outcome === "failed").length;
    const reasonGroups = {};
    for (const entry of fields) reasonGroups[entry.reason] = Number(reasonGroups[entry.reason] || 0) + 1;
    return {
      schema: "ApplicationExecution",
      schema_version: SCHEMA_VERSION,
      execution_id: cleanText(data.execution_id || data.run_id),
      attempt_id: cleanText(data.attempt_id || data.active_attempt_id),
      application_id: cleanText(data.application_id),
      job_id: cleanText(data.job_id),
      package_id: cleanText(data.package_id),
      run_id: cleanText(data.run_id),
      executor: normalizeExecutorMode(data.executor),
      portal: cleanText(data.portal || detectPortal(data.url)),
      url: cleanText(data.url),
      started_at: data.started_at || null,
      completed_at: data.completed_at || new Date().toISOString(),
      status: cleanText(data.status || (failed ? "needs_user_review" : "paused_for_user_review")),
      blocker: {
        blocked: Boolean(cleanText(data.blocked_reason)),
        reason: cleanText(data.blocked_reason),
      },
      challenge_scope: ["active", "passive", "none"].includes(cleanText(data.challenge_scope).toLowerCase())
        ? cleanText(data.challenge_scope).toLowerCase()
        : "none",
      submission_blocker: cleanText(data.submission_blocker),
      challenge_evidence: (Array.isArray(data.challenge_evidence) ? data.challenge_evidence : [])
        .map(cleanText).filter(Boolean).slice(0, 20),
      counts: { detected: fields.length, filled, skipped, failed },
      reason_groups: reasonGroups,
      field_results: fields,
      fields: {
        detected: fields,
        filled: fields.filter((entry) => entry.outcome === "filled"),
        skipped: fields.filter((entry) => entry.outcome === "skipped"),
        failed: fields.filter((entry) => entry.outcome === "failed"),
      },
      // Resume upload is recorded truthfully: the Browser Agent may have been
      // authorized to attach the tailored resume, and hiding that would make
      // the record lie. Login, challenge and submit remain hard-false — no
      // executor has a path that performs them.
      resume_upload: data.resume_upload && typeof data.resume_upload === "object"
        ? {
          attempted: data.resume_upload.attempted === true,
          status: cleanText(data.resume_upload.status),
          reason: cleanText(data.resume_upload.reason),
          already_uploaded: data.resume_upload.already_uploaded === true,
          file: data.resume_upload.file && typeof data.resume_upload.file === "object"
            ? { name: cleanText(data.resume_upload.file.name), format: cleanText(data.resume_upload.file.format) }
            : null,
          evidence: data.resume_upload.evidence && typeof data.resume_upload.evidence === "object"
            ? {
              input_holds_file: data.resume_upload.evidence.input_holds_file === true,
              page_shows_file_name: data.resume_upload.evidence.page_shows_file_name === true,
            }
            : null,
        }
        : null,
      safety: {
        upload_attempted: Boolean(data.safety && data.safety.upload_attempted === true),
        resume_uploaded: Boolean(data.safety && data.safety.resume_uploaded === true),
        login_attempted: false,
        challenge_attempted: false,
        submit_attempted: false,
        submitted: false,
        final_submit: false,
      },
      notes: (Array.isArray(data.notes) ? data.notes : []).map(cleanText).filter(Boolean).slice(0, 20),
    };
  }

  // ---- Question families ----------------------------------------------------
  // Cross-site question identity: different wordings of the SAME question
  // normalize to one family key, so a user-confirmed answer on one portal can
  // be reused when another portal asks it differently. Families are added for
  // ordinary reusable questions only — sensitive topics stay out on purpose
  // (they have their own policy and are never merged by guesswork).
  const QUESTION_FAMILIES = Object.freeze([
    {
      key: "q_hear_about_us",
      pattern: /(?:how|where)\s+did\s+you\s+(?:hear|learn|find\s*out)\s+about\s+(?:us|this|the)\b|how\s+did\s+you\s+hear\s+about/i,
    },
    {
      key: "q_notice_period",
      pattern: /notice\s+period|离职通知/i,
    },
    {
      key: "q_why_interested",
      // Open-ended motivation questions share one identity, but their answers
      // default to ask-per-job (reuse_policy 'ask') because a good answer is
      // company-specific — the family only powers suggestion, not blind reuse.
      pattern: /why\s+(?:do\s+you\s+want|are\s+you\s+interested|would\s+you\s+like)\s+to\s+(?:work|join)/i,
    },
  ]);

  function questionFamilyKey(value) {
    const text = cleanText(value);
    if (!text || SENSITIVE_PATTERN.test(normalizedText(text))) return "";
    for (const family of QUESTION_FAMILIES) {
      if (family.pattern.test(text)) return family.key;
    }
    return "";
  }

  // One sensitivity verdict for every layer (scan class, answer intake,
  // reuse policy): the same pattern the field-safety classifier applies.
  function isSensitiveQuestion(value) {
    return SENSITIVE_PATTERN.test(normalizedText(value));
  }

  // Which sensitive CATEGORY a question belongs to — drives the per-category
  // policy (ask / reuse / manual). Specific categories are checked before the
  // generic bucket; a non-sensitive question returns ''.
  const SENSITIVE_CATEGORY_PATTERNS = Object.freeze([
    ["sponsorship", /sponsor(?:ship)?/i],
    ["work_authorization", /work authorization|authoriz(?:ed|ation) to work|authoris(?:ed|ation) to work|right to work|legally (?:able|entitled|authorized) to work|work permit|\bvisa\b|immigration|citizen|nationality/i],
    ["eeo_demographics", /eeo|equal employment|gender|sex\b|race|ethnic|disab|veteran|military|religion|marital|sexual orientation|pronoun|date of birth|birth date|age\b/i],
    ["salary", /salary|compensation|pay expectation/i],
    ["relocation", /relocat/i],
    ["start_date", /start date|earliest start|available to start|availability date/i],
    ["background_check", /criminal|background check|drug test|medical|health|social security|ssn|government id|passport/i],
  ]);

  function sensitiveQuestionCategory(value) {
    const normalized = normalizedText(value);
    if (!normalized) return "";
    for (const [category, pattern] of SENSITIVE_CATEGORY_PATTERNS) {
      if (pattern.test(normalized)) return category;
    }
    return SENSITIVE_PATTERN.test(normalized) ? "other_sensitive" : "";
  }

  return Object.freeze({
    SCHEMA_VERSION,
    EXECUTOR_MODES,
    DEFAULT_FIELD_MAPPINGS,
    PORTAL_DEFINITIONS,
    QUESTION_FAMILIES,
    questionFamilyKey,
    isSensitiveQuestion,
    sensitiveQuestionCategory,
    cleanText,
    normalizedText,
    normalizeExecutorMode,
    detectPortal,
    isApplicationPage,
    portalDefinition,
    comparableExecutionUrl,
    withinApplicationScope,
    classifyPageSafety,
    normalizeFieldDescriptor,
    classifyFieldSafety,
    profileValue,
    fieldMapping,
    matchOptionForValue,
    planField,
    planFields,
    sanitizeFieldResult,
    createApplicationExecution,
  });
});
