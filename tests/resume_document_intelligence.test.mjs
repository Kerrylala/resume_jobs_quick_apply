import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  analyzeResumeDocument,
  analyzeResumeDocumentRobust,
  buildResumeFactSuggestions,
  extractDocxText,
  extractPdfText,
  extractResumeDocumentText,
  normalizeResumeText
} from '../scripts/lib/resume_document_intelligence.mjs';

test('robust analysis exposes resume text only as a transient non-serializable value', async () => {
  const analysis = await analyzeResumeDocumentRobust({
    content: Buffer.from('Synthetic Candidate\ncandidate@example.invalid\nPrivate narrative marker 493\nSkills: JavaScript'),
    fileName: 'synthetic.txt',
    contentHash: 'sha256:synthetic'
  });
  assert.match(analysis.transient_text, /Synthetic Candidate/);
  assert.equal(Object.keys(analysis).includes('transient_text'), false);
  assert.equal(JSON.stringify(analysis).includes('Private narrative marker 493'), false);
  assert.equal(analysis.raw_text_included, false);
});

test('resume text normalization applies Unicode NFKC and removes invisible separators', () => {
  assert.equal(normalizeResumeText('ＡＩ\u00a0Engineer\u200b'), 'AI Engineer');
});

test('Chinese resume sections create reviewable facts for all required profile categories', () => {
  const suggestions = buildResumeFactSuggestions(`张三
zhangsan@example.com | +86 13800138000
教育经历
示例大学 | 计算机科学 本科
实习/工作经历
示例公司 | 软件工程师 | 构建可靠服务
项目经历
求职助手 | 完成端到端工作流
技能/证书及其他
JavaScript、Node.js、SQL。语言: 中文、English`);
  const keys = new Set(suggestions.map(item => item.fact_key));
  for (const key of ['full_name', 'school', 'work_experience', 'projects', 'skills', 'languages']) {
    assert.equal(keys.has(key), true, `${key} should be reviewable`);
  }
});

test('a following volunteer section does not leak into project facts', () => {
  const suggestions = buildResumeFactSuggestions(`Projects
Fixture Project | delivered the core workflow
Volunteer Experience
Community Service | organized events`);
  const projects = suggestions.find(item => item.fact_key === 'projects')?.value || [];
  assert.equal(projects.length, 1);
  assert.match([projects[0].name, projects[0].description].join(' '), /Fixture Project/);
  assert.doesNotMatch(JSON.stringify(projects), /Community Service/);
  // The volunteer section becomes its own reviewable fact instead of leaking.
  const volunteer = suggestions.find(item => item.fact_key === 'volunteer_experience')?.value || [];
  assert.equal(volunteer.length, 1);
  assert.match(volunteer[0].company, /Community Service/);
});

test('US-layout experience groups company, role, dates, location, and bullets into ONE entry', () => {
  const suggestions = buildResumeFactSuggestions(`Synthetic Person
synthetic@example.com · (619) 000-0000
Experience
ABAmerica Jan 2026 - now
Marketing San Diego, CA
▪ Managed digital advertising campaigns.
▪ Monitored ad performance metrics
and adjusted budgets.
Bravo Travel Feb 2023 - Sep 2023
Travel Consultant San Diego, CA
▪ Managed 25+ daily bookings.`);
  const work = suggestions.find(item => item.fact_key === 'work_experience')?.value || [];
  assert.equal(work.length, 2);
  assert.equal(work[0].company, 'ABAmerica');
  assert.equal(work[0].role, 'Marketing');
  assert.equal(work[0].location, 'San Diego, CA');
  assert.match(work[0].dates, /Jan 2026/);
  assert.equal(work[0].responsibilities.length, 2);
  // The PDF wrap continuation joined the second bullet instead of becoming
  // its own shredded entry.
  assert.match(work[0].responsibilities[1], /and adjusted budgets/);
  assert.equal(work[1].company, 'Bravo Travel');
  assert.equal(work[1].role, 'Travel Consultant');
});

test('role-first layout, suffix headings, grouped skills and label languages all parse', () => {
  // The film-school template shape: role line ABOVE the company+dates line,
  // sections named "<X> EXPERIENCE", pipe entries, "Group: a, b" skills.
  const suggestions = buildResumeFactSuggestions(`Name (14 pt-16 pt font)
Athens, GA 30601 | Email | Phone Number | Website

PRODUCTION EXPERIENCE
Video Production Internship Athens, GA
LMC Media Jun 2024 - Aug 2024
- Completed video assignments to produce long and short format videos
Production Coordinator Athens, GA
Film Name/Film Type Jan 2024 - May 2024
- Managed inventory of production supplies and expendables

SELECTED PROJECT EXPERIENCE
Writer and Director, Project Name/Project Type Feb 2024 - Apr 2024
- Led a collaborative team of professionals for a feature-length student film

ADDITIONAL EXPERIENCE
UGA Performing Arts Center, Usher | Athens, GA Jan 2025 - Present
- Greet, assist, and accommodate patrons during recitals

SKILLS
Editing Software: Avid, Final Cut Pro, Adobe Premiere
Technical: Microsoft Office, Windows, and MAC OS
Language: Spanish (Intermediate)`);

  // The placeholder heading is NOT a name.
  assert.equal(suggestions.some(item => item.fact_key === 'full_name'), false);

  const work = suggestions.find(item => item.fact_key === 'work_experience')?.value || [];
  assert.equal(work.length, 3, JSON.stringify(work.map(entry => entry.company)));
  assert.equal(work[0].company, 'LMC Media');
  assert.equal(work[0].role, 'Video Production Internship');
  assert.equal(work[0].location, 'Athens, GA');
  assert.equal(work[1].company, 'Film Name/Film Type');
  assert.equal(work[1].role, 'Production Coordinator');
  assert.equal(work[2].company, 'UGA Performing Arts Center');
  assert.equal(work[2].role, 'Usher');
  assert.equal(work[2].location, 'Athens, GA');

  const projects = suggestions.find(item => item.fact_key === 'projects')?.value || [];
  assert.equal(projects.length, 1);
  assert.match(projects[0].name, /Writer and Director/);

  const skills = suggestions.find(item => item.fact_key === 'skills')?.value || [];
  assert.ok(skills.includes('Avid'), JSON.stringify(skills));
  assert.ok(skills.includes('MAC OS'), 'list-final "and" must be stripped');
  assert.equal(skills.some(item => item.includes(':')), false, 'group labels are headings, not skills');

  const languages = suggestions.find(item => item.fact_key === 'languages')?.value || [];
  assert.ok(languages.includes('Spanish (Intermediate)'), JSON.stringify(languages));
  assert.equal(skills.includes('Spanish (Intermediate)'), false);
});

function syntheticZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name);
    const content = Buffer.from(entry.value);
    const compressed = entry.deflate ? zlib.deflateRawSync(content) : content;
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function syntheticDocx() {
  return syntheticZip([
    { name: '[Content_Types].xml', value: '<Types/>', deflate: false },
    {
      name: 'word/document.xml',
      deflate: true,
      value: `<?xml version="1.0"?>
        <w:document xmlns:w="urn:test"><w:body>
          <w:p><w:r><w:t>Synthetic Candidate</w:t></w:r></w:p>
          <w:p><w:r><w:t>candidate@local.invalid</w:t></w:r></w:p>
          <w:p><w:r><w:t>LinkedIn: https://linkedin.com/in/synthetic-candidate</w:t></w:r></w:p>
          <w:p><w:r><w:t>Skills: roadmapping, analytics</w:t></w:r></w:p>
        </w:body></w:document>`
    }
  ]);
}

function syntheticPdf() {
  const stream = `BT
/F1 12 Tf
72 720 Td
(Synthetic Candidate) Tj
0 -20 Td
(candidate@local.invalid) Tj
0 -20 Td
(+1 555-010-1234) Tj
0 -20 Td
(https://github.com/synthetic-candidate) Tj
ET`;
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Length ${Buffer.byteLength(stream)} >>
stream
${stream}
endstream
endobj
%%EOF
`, 'latin1');
}

function syntheticFlatePdf() {
  const stream = Buffer.from('BT\n/F1 12 Tf\n72 720 Td\n(Compressed Synthetic Candidate) Tj\nET', 'latin1');
  const compressed = zlib.deflateSync(stream);
  return Buffer.concat([
    Buffer.from(`%PDF-1.4
1 0 obj
<< /Length ${compressed.length} /Filter /FlateDecode >>
stream
`, 'latin1'),
    compressed,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')
  ]);
}

test('native DOCX extraction reads compressed Word XML without external dependencies', () => {
  const extracted = extractDocxText(syntheticDocx());
  assert.equal(extracted.format, 'docx');
  assert.equal(extracted.extraction_method, 'docx_word_document_xml');
  assert.match(extracted.text, /Synthetic Candidate/);
  assert.match(extracted.text, /candidate@local\.invalid/);
  assert.match(extracted.text, /roadmapping, analytics/);
});

test('best-effort PDF extraction reads uncompressed synthetic text streams', () => {
  const extracted = extractPdfText(syntheticPdf());
  assert.equal(extracted.format, 'pdf');
  assert.equal(extracted.extraction_method, 'pdf_text_stream_best_effort');
  assert.match(extracted.text, /Synthetic Candidate/);
  assert.match(extracted.text, /candidate@local\.invalid/);
  assert.match(extracted.text, /\+1 555-010-1234/);
});

test('best-effort PDF extraction supports bounded FlateDecode text streams', () => {
  const extracted = extractPdfText(syntheticFlatePdf());
  assert.match(extracted.text, /Compressed Synthetic Candidate/);
});

test('UTF-8 TXT extraction is bounded and rejects binary text', () => {
  const extracted = extractResumeDocumentText(
    Buffer.from('Synthetic Candidate\nSkills: analytics, roadmapping', 'utf8'),
    { fileName: 'synthetic.txt' }
  );
  assert.equal(extracted.format, 'txt');
  assert.equal(extracted.extraction_method, 'utf8_plain_text');
  assert.match(extracted.text, /analytics/);
  assert.throws(
    () => extractResumeDocumentText(Buffer.from([0, 1, 2, 3, 255]), { fileName: 'binary.txt' }),
    error => ['INVALID_TEXT_ENCODING', 'INVALID_TEXT_CONTENT'].includes(error.code)
  );
});

test('document analysis returns review-only suggestions and never returns raw text', () => {
  const analysis = analyzeResumeDocument({
    content: syntheticPdf(),
    fileName: 'synthetic.pdf',
    contentHash: 'sha256:synthetic',
    existingFacts: [{ fact_key: 'email', value: 'existing@local.invalid' }]
  });
  assert.equal(analysis.analysis_mode, 'explicit_local_preview');
  assert.equal(analysis.raw_text_included, false);
  assert.equal(Object.hasOwn(analysis, 'text'), false);
  assert.equal(analysis.persistence.raw_text_saved, false);
  assert.equal(analysis.persistence.suggestions_saved, false);
  assert.equal(analysis.persistence.candidate_profile_modified, false);
  assert.match(analysis.snapshot_token, /^sha256:[a-f0-9]{64}$/);
  const email = analysis.suggestions.find(item => item.fact_key === 'email');
  assert.equal(email.value, 'candidate@local.invalid');
  assert.equal(email.user_confirmed, false);
  assert.equal(email.existing_fact_present, true);
  assert.equal(analysis.suggestions.find(item => item.fact_key === 'github').confidence, 0.98);
});

test('fact suggestions stay unconfirmed and identify existing-fact conflicts', () => {
  const suggestions = buildResumeFactSuggestions(
    'Synthetic Candidate\ncandidate@local.invalid\nPortfolio: https://portfolio.local.invalid',
    { existingFacts: [{ fact_key: 'full_name' }] }
  );
  assert.ok(suggestions.length >= 3);
  assert.ok(suggestions.every(item => item.status === 'review_required' && item.user_confirmed === false));
  assert.equal(suggestions.find(item => item.fact_key === 'full_name').existing_fact_present, true);
  assert.equal(suggestions.find(item => item.fact_key === 'portfolio').value, 'https://portfolio.local.invalid');
});

test('structured resume sections become review-only skills, experience, projects, and achievements', () => {
  const suggestions = buildResumeFactSuggestions(`Synthetic Candidate
Skills: JavaScript, analytics, roadmapping
Experience
- Product analyst at Synthetic Company
- Shipped a local-only workflow
Projects
- Resume Jobs demo
Awards
- Synthetic Award
Languages: English, Chinese`);
  assert.deepEqual(suggestions.find(item => item.fact_key === 'skills').value, ['JavaScript', 'analytics', 'roadmapping']);
  // Bullet-only sections group into one entry that OWNS its bullets — the
  // old line-per-entry shape shredded resumes into heading-less stubs.
  assert.deepEqual(suggestions.find(item => item.fact_key === 'work_experience').value, [
    {
      company: '', role: '', dates: '', location: '',
      responsibilities: ['Product analyst at Synthetic Company', 'Shipped a local-only workflow']
    }
  ]);
  assert.deepEqual(suggestions.find(item => item.fact_key === 'projects').value, [
    { name: '', dates: '', description: 'Resume Jobs demo', results: [] }
  ]);
  assert.deepEqual(suggestions.find(item => item.fact_key === 'awards').value, ['Synthetic Award']);
  assert.deepEqual(suggestions.find(item => item.fact_key === 'languages').value, ['English', 'Chinese']);
  assert.ok(suggestions.every(item => item.user_confirmed === false && item.status === 'review_required'));
});

test('unsupported, encrypted, and textless documents fail explicitly', () => {
  assert.throws(
    () => extractResumeDocumentText(Buffer.from('plain text'), { fileName: 'resume.rtf' }),
    error => error.code === 'UNSUPPORTED_DOCUMENT_TYPE'
  );
  assert.throws(
    () => extractPdfText(Buffer.from('%PDF-1.4\n/Encrypt 2 0 R\n%%EOF\n')),
    error => error.code === 'ENCRYPTED_PDF_UNSUPPORTED'
  );
  assert.throws(
    () => extractPdfText(Buffer.from('%PDF-1.4\nscanned image only\n%%EOF\n')),
    error => error.code === 'NO_EXTRACTABLE_TEXT'
  );
});
