// One render model, two outputs.
//
// draftRenderModel turns a stored tailored-resume draft into a neutral layout
// model; buildResumeDocx and renderResumeHtml both consume it, so the DOCX a
// user edits and the PDF they attach can never diverge in content. Cut lines
// never enter the model — they live in the draft's review block, restorable
// but not printed.

function text(value, limit = 2000) {
  return String(value ?? '').trim().slice(0, limit);
}

// Bullet text stored by older parses may still carry its own list glyph;
// the template draws the marker, so a doubled "• ▪ …" must never render.
function bulletText(value, limit = 2000) {
  return text(String(value ?? '').replace(/^[-*•▪‣◦·]+\s*/u, ''), limit);
}

const SECTION_TITLES = {
  summary: 'Summary',
  skills: 'Skills',
  experience: 'Experience',
  projects: 'Projects',
  education: 'Education'
};

const SKILL_GROUP_LABELS = {
  programming: 'Programming',
  ai_tools: 'AI Tools',
  frameworks: 'Frameworks',
  cloud: 'Cloud',
  data: 'Data',
  business: 'Business',
  languages: 'Languages'
};

export function draftRenderModel(draft) {
  const blocks = Array.isArray(draft?.blocks) ? draft.blocks : [];
  const model = { name: '', contact_line: '', sections: [] };

  const header = blocks.find(block => block.kind === 'header');
  if (header) {
    const items = header.items || [];
    const nameItem = items.find(item => item.fact_refs?.[0] === 'identity.full_name') || items[0];
    model.name = text(nameItem?.text, 200);
    model.contact_line = items
      .filter(item => item !== nameItem)
      .map(item => text(item.text, 300))
      .filter(Boolean)
      .join('  ·  ');
  }

  for (const block of blocks) {
    if (block.kind === 'header') continue;

    if (block.kind === 'summary') {
      const lines = (block.items || []).map(item => text(item.text)).filter(Boolean);
      if (lines.length) model.sections.push({ key: 'summary', title: SECTION_TITLES.summary, lines });
      continue;
    }

    if (block.kind === 'skills') {
      const byGroup = new Map();
      for (const item of block.items || []) {
        if (!byGroup.has(item.group)) byGroup.set(item.group, []);
        byGroup.get(item.group).push(text(item.text, 200));
      }
      const lines = [...byGroup.entries()]
        .filter(([, skills]) => skills.length)
        .map(([group, skills]) => `${SKILL_GROUP_LABELS[group] || group}: ${skills.join(', ')}`);
      if (lines.length) model.sections.push({ key: 'skills', title: SECTION_TITLES.skills, lines });
      continue;
    }

    if (block.kind === 'experience') {
      const entries = (block.entries || []).map(entry => ({
        heading: [entry.role, entry.company].filter(Boolean).join(' — '),
        // Split fields so templates can lay company and role out separately
        // (heading stays for templates that print one line).
        company: text(entry.company, 300),
        role: text(entry.role, 300),
        dates: text(entry.dates, 100),
        bullets: (entry.bullets || []).map(bullet => bulletText(bullet.text)).filter(Boolean)
        // A heading-less entry still owns its bullets — content survives an
        // imperfect parse instead of vanishing from the rendered file.
      })).filter(entry => entry.heading || entry.bullets.length);
      if (entries.length) model.sections.push({ key: 'experience', title: SECTION_TITLES.experience, entries });
      continue;
    }

    if (block.kind === 'projects') {
      const entries = (block.entries || []).map(entry => ({
        heading: text(entry.name, 300),
        company: text(entry.name, 300),
        role: '',
        dates: '',
        bullets: (entry.bullets || []).map(bullet => bulletText(bullet.text)).filter(Boolean)
      })).filter(entry => entry.heading || entry.bullets.length);
      if (entries.length) model.sections.push({ key: 'projects', title: SECTION_TITLES.projects, entries });
      continue;
    }

    if (block.kind === 'education') {
      const entries = (block.entries || []).map(entry => ({
        heading: [entry.degree, entry.field_of_study].filter(Boolean).join(', '),
        company: text(entry.institution, 300),
        role: [entry.degree, entry.field_of_study].filter(Boolean).join(' · '),
        subheading: text(entry.institution, 300),
        dates: text(entry.dates, 100),
        bullets: []
      })).filter(entry => entry.heading || entry.subheading);
      if (entries.length) model.sections.push({ key: 'education', title: SECTION_TITLES.education, entries });
    }
  }

  return model;
}

// --- HTML (the PDF source) --------------------------------------------------

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderResumeHtml(model) {
  const sections = model.sections.map(section => {
    const lines = (section.lines || [])
      .map(line => `<p class="line">${htmlEscape(line)}</p>`).join('');
    const entries = (section.entries || []).map(entry => `
      <div class="entry">
        <div class="entry-head">
          <span class="entry-title">${htmlEscape(entry.heading)}</span>
          ${entry.dates ? `<span class="entry-dates">${htmlEscape(entry.dates)}</span>` : ''}
        </div>
        ${entry.subheading ? `<div class="entry-sub">${htmlEscape(entry.subheading)}</div>` : ''}
        ${entry.bullets?.length ? `<ul>${entry.bullets.map(bullet => `<li>${htmlEscape(bullet)}</li>`).join('')}</ul>` : ''}
      </div>`).join('');
    return `<section><h2>${htmlEscape(section.title)}</h2>${lines}${entries}</section>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: Calibri, 'Helvetica Neue', Arial, 'Microsoft YaHei', 'PingFang SC', sans-serif;
      font-size: 10.5pt; color: #1a1a1a; line-height: 1.35;
    }
    h1 { font-size: 20pt; letter-spacing: 0.5px; }
    .contact { font-size: 9pt; color: #555; margin: 2pt 0 10pt; }
    h2 {
      font-size: 11pt; text-transform: uppercase; letter-spacing: 1px;
      border-bottom: 1px solid #444; padding-bottom: 2pt; margin: 12pt 0 6pt;
    }
    .line { margin: 2pt 0; }
    .entry { margin: 6pt 0 4pt; }
    .entry-head { display: flex; justify-content: space-between; align-items: baseline; }
    .entry-title { font-weight: bold; }
    .entry-dates { font-style: italic; color: #555; font-size: 9.5pt; white-space: nowrap; margin-left: 8pt; }
    .entry-sub { font-style: italic; color: #333; font-size: 10pt; }
    ul { margin: 2pt 0 0 14pt; }
    li { margin: 1.5pt 0; }
  </style></head><body>
    <h1>${htmlEscape(model.name)}</h1>
    ${model.contact_line ? `<p class="contact">${htmlEscape(model.contact_line)}</p>` : ''}
    ${sections}
  </body></html>`;
}

// --- classic_cn — the user's official template -----------------------------
//
// Layout reference: WonderCV-style Chinese resume. Centered section titles
// over a thin full-width rule; per entry the company sits bold on the left
// with the date range right-aligned, the role/department line beneath, then
// round-bullet lines. Section order: 个人总结 → 工作经历 → 项目经历 →
// 教育经历 → 其他(技能). Every value is verbatim from the render model —
// the template changes LOOK only, never content.
export const CLASSIC_CN_TITLES = {
  summary: '个人总结',
  experience: '工作经历',
  projects: '项目经历',
  education: '教育经历',
  skills: '其他'
};
const CLASSIC_CN_ORDER = ['summary', 'experience', 'projects', 'education', 'skills'];

export function renderResumeHtmlClassicCn(model, { titles = CLASSIC_CN_TITLES, lang = 'zh-CN' } = {}) {
  const sectionsByKey = new Map((model.sections || []).map(section => [section.key || section.title, section]));
  const orderedSections = CLASSIC_CN_ORDER
    .map(key => ({ key, section: sectionsByKey.get(key) }))
    .filter(item => item.section);

  const renderSection = ({ key, section }) => {
    const title = titles[key] || section.title;
    const lines = (section.lines || [])
      .map(line => key === 'skills'
        ? `<p class="line skill-line"><span class="skill-icon">◆</span>${htmlEscape(line)}</p>`
        : `<p class="line">${htmlEscape(line)}</p>`)
      .join('');
    const entries = (section.entries || []).map(entry => `
      <div class="entry">
        <div class="entry-head">
          <span class="entry-org">${htmlEscape(entry.company || entry.heading)}</span>
          ${entry.dates ? `<span class="entry-dates">${htmlEscape(entry.dates)}</span>` : ''}
        </div>
        ${entry.role && entry.role !== (entry.company || '') ? `<div class="entry-role">${htmlEscape(entry.role)}</div>` : ''}
        ${entry.bullets?.length ? `<ul>${entry.bullets.map(bullet => `<li>${htmlEscape(bullet)}</li>`).join('')}</ul>` : ''}
      </div>`).join('');
    return `<section><h2>${htmlEscape(title)}</h2><div class="rule"></div>${lines}${entries}</section>`;
  };

  return `<!DOCTYPE html><html lang="${htmlEscape(lang)}"><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Times New Roman', 'SimSun', 'Songti SC', 'Microsoft YaHei', serif;
      font-size: 10.5pt; color: #1c2733; line-height: 1.5;
    }
    header.identity { margin-bottom: 6pt; }
    h1 { font-size: 19pt; letter-spacing: 1px; font-family: 'SimHei', 'Microsoft YaHei', 'Times New Roman', sans-serif; }
    .contact { font-size: 10pt; color: #333; margin-top: 4pt; }
    h2 {
      font-size: 13pt; text-align: center; letter-spacing: 4px;
      font-family: 'SimHei', 'Microsoft YaHei', sans-serif; margin: 12pt 0 0;
      color: #1c2733;
    }
    .rule { border-bottom: 1.2px solid #2b3a4a; margin: 3pt 0 7pt; }
    .line { margin: 2pt 0; text-align: justify; }
    .skill-line { margin: 4pt 0; }
    .skill-icon { margin-right: 6pt; font-size: 8pt; vertical-align: 1pt; }
    .entry { margin: 5pt 0 7pt; }
    .entry-head { display: flex; justify-content: space-between; align-items: baseline; }
    .entry-org { font-weight: bold; font-size: 11pt; }
    .entry-dates { color: #333; font-size: 10pt; white-space: nowrap; margin-left: 10pt; }
    .entry-role { font-size: 10.5pt; color: #222; margin-top: 1pt; }
    ul { margin: 2.5pt 0 0 0; padding-left: 0; list-style: none; }
    li { margin: 2pt 0; padding-left: 14pt; position: relative; text-align: justify; }
    li::before { content: '●'; position: absolute; left: 0; top: 0; font-size: 6.5pt; line-height: 2.4; }
  </style></head><body>
    <header class="identity">
      <h1>${htmlEscape(model.name)}</h1>
      ${model.contact_line ? `<p class="contact">${htmlEscape(model.contact_line)}</p>` : ''}
    </header>
    ${orderedSections.map(renderSection).join('')}
  </body></html>`;
}

// --- Template registry ------------------------------------------------------
//
// The RENDERING of a draft is replaceable without touching draft generation,
// grounding validation, coverage verification, or file binding. A renderer
// receives the render MODEL (draftRenderModel output) and produces the HTML
// used for the PDF; the DOCX builder is looked up the same way. The user's
// official template will register here as a new entry — nothing upstream
// changes.
// Same layout, English section headers (the render model's own titles) — for
// resumes whose content is English; Chinese headers on an English resume read
// as a rendering bug to any recruiter.
export function renderResumeHtmlClassicEn(model) {
  return renderResumeHtmlClassicCn(model, { titles: {}, lang: 'en' });
}

// Pick the classic variant whose header language matches the CONTENT: if the
// draft's text is mostly non-CJK, English headers; otherwise the Chinese
// original. Purely a look decision — content is identical either way.
export function detectResumeTemplateForModel(model = {}) {
  const textBody = [
    model.name,
    ...(model.sections || []).flatMap(section => [
      ...(section.lines || []),
      ...(section.entries || []).flatMap(entry => [entry.heading, entry.role, ...(entry.bullets || [])])
    ])
  ].filter(Boolean).join(' ');
  const cjk = (textBody.match(/[一-鿿]/g) || []).length;
  const total = textBody.replace(/\s+/g, '').length || 1;
  return cjk / total >= 0.15 ? 'classic_cn' : 'classic_en';
}

const RESUME_TEMPLATES = new Map([
  // classic_cn is the user's official template and the product default;
  // the original layout stays available as 'legacy'.
  ['classic_cn', { html: renderResumeHtmlClassicCn }],
  ['classic_en', { html: renderResumeHtmlClassicEn }],
  ['default', { html: renderResumeHtmlClassicCn }],
  ['legacy', { html: renderResumeHtml }],
]);

export function registerResumeTemplate(name, renderer) {
  if (!name || !renderer || typeof renderer.html !== 'function') {
    throw new Error('A resume template needs a name and an html(model) renderer.');
  }
  RESUME_TEMPLATES.set(String(name), renderer);
}

export function resumeTemplate(name = 'default') {
  return RESUME_TEMPLATES.get(String(name || 'default')) || RESUME_TEMPLATES.get('default');
}
