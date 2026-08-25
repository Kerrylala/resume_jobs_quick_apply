import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_DECOMPRESSED_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_DECOMPRESSED_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;

export class ResumeDocumentAnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResumeDocumentAnalysisError';
    this.code = code;
  }
}

function analysisError(code, message) {
  throw new ResumeDocumentAnalysisError(code, message);
}

function text(value) {
  return String(value ?? '').trim();
}

export function normalizeResumeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

const normalizeText = normalizeResumeText;

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function findEndOfCentralDirectory(content) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const minimumOffset = Math.max(0, content.length - 65_557);
  const offset = content.lastIndexOf(signature);
  return offset >= minimumOffset && offset + 22 <= content.length ? offset : -1;
}

export function readZipDirectory(content) {
  if (!Buffer.isBuffer(content)) analysisError('INVALID_DOCUMENT_CONTENT', 'Document content must be a Buffer.');
  const endOffset = findEndOfCentralDirectory(content);
  if (endOffset < 0) analysisError('INVALID_DOCX_CONTAINER', 'DOCX central directory was not found.');
  const entryCount = content.readUInt16LE(endOffset + 10);
  const centralSize = content.readUInt32LE(endOffset + 12);
  const centralOffset = content.readUInt32LE(endOffset + 16);
  if (entryCount > 10_000 || centralOffset + centralSize > endOffset) {
    analysisError('INVALID_DOCX_CONTAINER', 'DOCX central directory is invalid.');
  }

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > content.length || content.readUInt32LE(offset) !== 0x02014b50) {
      analysisError('INVALID_DOCX_CONTAINER', 'DOCX entry metadata is invalid.');
    }
    const flags = content.readUInt16LE(offset + 8);
    const compression_method = content.readUInt16LE(offset + 10);
    const compressed_size = content.readUInt32LE(offset + 20);
    const uncompressed_size = content.readUInt32LE(offset + 24);
    const nameLength = content.readUInt16LE(offset + 28);
    const extraLength = content.readUInt16LE(offset + 30);
    const commentLength = content.readUInt16LE(offset + 32);
    const local_header_offset = content.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > content.length) analysisError('INVALID_DOCX_CONTAINER', 'DOCX entry exceeds the file boundary.');
    const name = content.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.push({
      name,
      flags,
      compression_method,
      compressed_size,
      uncompressed_size,
      local_header_offset
    });
    offset = next;
  }
  return entries;
}

export function zipEntryNames(content) {
  return readZipDirectory(content).map(entry => entry.name);
}

function readZipEntry(content, entry) {
  if (entry.flags & 0x1) analysisError('ENCRYPTED_DOCX_UNSUPPORTED', 'Encrypted DOCX files are not supported.');
  if (entry.uncompressed_size > MAX_DECOMPRESSED_ENTRY_BYTES) {
    analysisError('DOCX_ENTRY_TOO_LARGE', 'DOCX document text exceeds the safe local analysis limit.');
  }
  const offset = entry.local_header_offset;
  if (offset + 30 > content.length || content.readUInt32LE(offset) !== 0x04034b50) {
    analysisError('INVALID_DOCX_CONTAINER', 'DOCX local entry header is invalid.');
  }
  const nameLength = content.readUInt16LE(offset + 26);
  const extraLength = content.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressed_size;
  if (dataEnd > content.length) analysisError('INVALID_DOCX_CONTAINER', 'DOCX entry data exceeds the file boundary.');
  const compressed = content.subarray(dataStart, dataEnd);
  let output;
  if (entry.compression_method === 0) output = Buffer.from(compressed);
  else if (entry.compression_method === 8) {
    try {
      output = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_ENTRY_BYTES });
    } catch {
      analysisError('DOCX_DECOMPRESSION_FAILED', 'DOCX document text could not be decompressed safely.');
    }
  } else {
    analysisError('UNSUPPORTED_DOCX_COMPRESSION', `DOCX compression method ${entry.compression_method} is not supported.`);
  }
  if (output.length > MAX_DECOMPRESSED_ENTRY_BYTES) {
    analysisError('DOCX_ENTRY_TOO_LARGE', 'DOCX document text exceeds the safe local analysis limit.');
  }
  return output;
}

export function extractDocxText(content) {
  const entries = readZipDirectory(content);
  const documentEntry = entries.find(entry => entry.name === 'word/document.xml');
  if (!entries.some(entry => entry.name === '[Content_Types].xml') || !documentEntry) {
    analysisError('INVALID_DOCX_CONTAINER', 'DOCX is missing required document entries.');
  }
  const xml = readZipEntry(content, documentEntry).toString('utf8');
  const extracted = decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/gi, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/gi, '\n')
      .replace(/<\/w:p>/gi, '\n')
      .replace(/<\/w:tr>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
  const normalized = normalizeText(extracted);
  if (!normalized) analysisError('NO_EXTRACTABLE_TEXT', 'No text could be extracted from this DOCX file.');
  return {
    format: 'docx',
    text: normalized,
    extraction_method: 'docx_word_document_xml',
    warnings: []
  };
}

function decodePdfLiteral(value) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      output += character;
      continue;
    }
    const next = value[++index];
    if (next === undefined) break;
    const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    if (Object.hasOwn(escapes, next)) {
      output += escapes[next];
      continue;
    }
    if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(value[index + 1] || '')) octal += value[++index];
      output += String.fromCharCode(Number.parseInt(octal, 8));
      continue;
    }
    if (next === '\r' && value[index + 1] === '\n') index += 1;
    else if (next !== '\n' && next !== '\r') output += next;
  }
  return output;
}

function pdfLiteralStrings(source) {
  const values = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '(') continue;
    let depth = 1;
    let escaped = false;
    let value = '';
    for (index += 1; index < source.length && depth > 0; index += 1) {
      const character = source[index];
      if (escaped) {
        value += `\\${character}`;
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '(') {
        depth += 1;
        value += character;
      } else if (character === ')') {
        depth -= 1;
        if (depth > 0) value += character;
      } else {
        value += character;
      }
    }
    if (depth === 0) values.push(decodePdfLiteral(value));
  }
  return values;
}

function decodePdfHex(value) {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || /[^0-9a-f]/i.test(normalized)) return '';
  const padded = normalized.length % 2 ? `${normalized}0` : normalized;
  const bytes = Buffer.from(padded, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let output = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      output += String.fromCharCode(bytes.readUInt16BE(index));
    }
    return output;
  }
  return bytes.toString('latin1');
}

function extractPdfStreams(content) {
  const source = content.toString('latin1');
  const streams = [];
  const pattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  let totalBytes = 0;
  while ((match = pattern.exec(source)) && streams.length < 200) {
    const dictionary = source.slice(Math.max(0, match.index - 1_024), match.index);
    let value = Buffer.from(match[1], 'latin1');
    if (/\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(dictionary)) {
      try {
        value = zlib.inflateSync(value, { maxOutputLength: MAX_DECOMPRESSED_ENTRY_BYTES });
      } catch {
        continue;
      }
    } else if (/\/Filter\b/.test(dictionary)) {
      continue;
    }
    totalBytes += value.length;
    if (totalBytes > MAX_DECOMPRESSED_TOTAL_BYTES) {
      analysisError('PDF_TEXT_TOO_LARGE', 'PDF text streams exceed the safe local analysis limit.');
    }
    streams.push(value.toString('latin1'));
  }
  return streams;
}

export function extractPdfText(content) {
  if (content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    analysisError('INVALID_PDF_SIGNATURE', 'The selected file does not have a valid PDF signature.');
  }
  const header = content.subarray(0, Math.min(content.length, 250_000)).toString('latin1');
  if (/\/Encrypt\b/.test(header)) analysisError('ENCRYPTED_PDF_UNSUPPORTED', 'Encrypted PDF files are not supported.');
  const chunks = [];
  for (const stream of extractPdfStreams(content)) {
    if (!/\bBT\b[\s\S]*\bET\b/.test(stream)) continue;
    chunks.push(...pdfLiteralStrings(stream));
    for (const match of stream.matchAll(/<([0-9a-f\s]+)>\s*(?:Tj|'|")/gi)) {
      chunks.push(decodePdfHex(match[1]));
    }
  }
  const normalized = normalizeText(chunks.join('\n'));
  if (!normalized) {
    analysisError(
      'NO_EXTRACTABLE_TEXT',
      'No text could be extracted. The PDF may be scanned, encrypted, or use an unsupported font encoding.'
    );
  }
  return {
    format: 'pdf',
    text: normalized,
    extraction_method: 'pdf_text_stream_best_effort',
    warnings: ['PDF extraction is best-effort; review every suggested fact before use.']
  };
}

export async function extractPdfTextRobust(content) {
  if (content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    analysisError('INVALID_PDF_SIGNATURE', 'The selected file does not have a valid PDF signature.');
  }
  const header = content.subarray(0, Math.min(content.length, 250_000)).toString('latin1');
  if (/\/Encrypt\b/.test(header)) analysisError('ENCRYPTED_PDF_UNSUPPORTED', 'Encrypted PDF files are not supported.');
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await getDocument({
      data: new Uint8Array(content),
      disableWorker: true,
      useSystemFonts: true,
      isEvalSupported: false
    }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const contentItems = await page.getTextContent({ disableNormalization: false });
      pages.push(contentItems.items
        .map(item => `${String(item?.str || '')}${item?.hasEOL ? '\n' : ''}`)
        .join(''));
    }
    const normalized = normalizeText(pages.join('\n'));
    if (!normalized) analysisError('NO_EXTRACTABLE_TEXT', 'No text could be extracted from this PDF file.');
    return {
      format: 'pdf',
      text: normalized,
      extraction_method: 'pdfjs_text_content_with_unicode_normalization',
      warnings: ['PDF text was normalized with NFKC; review every suggested fact before use.']
    };
  } catch (error) {
    if (error instanceof ResumeDocumentAnalysisError) throw error;
    try {
      const fallback = extractPdfText(content);
      return {
        ...fallback,
        warnings: [...fallback.warnings, 'The primary PDF parser failed; a best-effort stream fallback was used.']
      };
    } catch {
      analysisError('PDF_TEXT_EXTRACTION_FAILED', `PDF text extraction failed: ${error?.message || String(error)}`);
    }
  }
}

export function extractResumeDocumentText(content, { fileName = '' } = {}) {
  if (!Buffer.isBuffer(content) || !content.length) {
    analysisError('EMPTY_DOCUMENT', 'Resume document is empty.');
  }
  if (content.length > MAX_DOCUMENT_BYTES) {
    analysisError('DOCUMENT_TOO_LARGE', `Resume document must not exceed ${MAX_DOCUMENT_BYTES} bytes.`);
  }
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (extension === '.pdf') return extractPdfText(content);
  if (extension === '.docx') return extractDocxText(content);
  if (extension === '.txt') {
    let decoded;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^\uFEFF/, '');
    } catch {
      analysisError('INVALID_TEXT_ENCODING', 'TXT resume files must use valid UTF-8 text encoding.');
    }
    const controlCharacters = [...decoded].filter(character => {
      const code = character.codePointAt(0);
      return code < 32 && !['\t', '\n', '\r'].includes(character);
    }).length;
    if (decoded.includes('\u0000') || controlCharacters > Math.max(2, decoded.length * 0.01)) {
      analysisError('INVALID_TEXT_CONTENT', 'TXT resume must contain readable plain text, not binary content.');
    }
    const normalized = normalizeText(decoded);
    if (!normalized) analysisError('NO_EXTRACTABLE_TEXT', 'The TXT resume contains no readable text.');
    return {
      format: 'txt',
      text: normalized,
      extraction_method: 'utf8_plain_text',
      warnings: []
    };
  }
  analysisError('UNSUPPORTED_DOCUMENT_TYPE', 'Only PDF, DOCX, and TXT resume analysis is supported.');
}

function firstMatch(value, pattern) {
  return String(value || '').match(pattern)?.[0] || '';
}

function labeledValue(value, labels) {
  const expression = new RegExp(`(?:^|\\n|[。；;])\\s*(?:${labels.join('|')})\\s*[:：]\\s*([^\\n。；;]{2,160})`, 'iu');
  return String(value || '').match(expression)?.[1]?.trim() || '';
}

const SECTION_GROUPS = Object.freeze({
  summary: ['summary', 'profile', 'professional summary', '个人简介', '职业概述'],
  skills: ['skills', 'technical skills', 'technologies', 'tech stack', '技能', '技术栈', '专业技能', '技能/证书及其他', '技能与证书'],
  // coursework has no consumer yet — the aliases exist so an unknown
  // "RELEVANT COURSEWORK" heading TERMINATES the previous section instead of
  // being swallowed into it (certifications used to absorb the whole block).
  coursework: ['relevant coursework', 'coursework', '核心课程', '主修课程', '相关课程'],
  experience: ['experience', 'work experience', 'employment', 'professional experience', '工作经历', '工作经验', '实习/工作经历', '实习经历'],
  projects: ['projects', 'selected projects', 'project experience', '项目', '项目经历'],
  volunteer: ['volunteer experience', 'volunteer', 'volunteering', 'leadership experience', '社团和组织经历', '志愿者经历', '志愿者', '志愿服务'],
  education: ['education', 'academic background', '教育', '教育经历'],
  awards: ['awards', 'honors', 'achievements', '荣誉', '获奖', '成就'],
  certifications: ['certifications', 'certificates', 'licenses', '证书', '认证'],
  languages: ['languages', 'language skills', '语言', '语言能力', '语言技能']
});

function escapedRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SECTION_HEADING_PATTERN = new RegExp(
  `^(?:${Object.values(SECTION_GROUPS).flat().map(escapedRegExp).join('|')})\\s*(?:(?::|：)\\s*.*)?$`,
  'iu'
);

// Real resumes name their sections freely: "PRODUCTION EXPERIENCE",
// "SELECTED PROJECT EXPERIENCE", "ADDITIONAL EXPERIENCE". Exact-alias
// matching dropped every one of those blocks on the floor, so a short
// heading-shaped line ending in a known section word is REWRITTEN to its
// canonical alias before section parsing. Prose never qualifies: headings
// are short, bullet-free, and carry no sentence punctuation.
function canonicalizeSectionHeadings(value) {
  return String(value || '').split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 44) return line;
    if (/[,.;。；、|]/.test(trimmed)) return line;
    if (ENTRY_BULLET_RE.test(trimmed)) return line;
    if (SECTION_HEADING_PATTERN.test(trimmed)) return line;
    const words = trimmed.split(/\s+/);
    if (words.length < 2 || words.length > 4) return line;
    if (!/^[A-Za-z&/()\s\p{Script=Han}]+$/u.test(trimmed)) return line;
    const lowered = trimmed.toLowerCase();
    if (/(?:experience|经历|经验)$/u.test(lowered)) {
      if (/\bproject/u.test(lowered) || /项目/u.test(lowered)) return 'Project Experience';
      if (/\b(?:volunteer|leadership)/u.test(lowered) || /志愿|社团/u.test(lowered)) return 'Volunteer Experience';
      return 'Experience';
    }
    return line;
  }).join('\n');
}

function sectionLines(value, aliases) {
  const lines = normalizeText(value).split('\n').map(line => line.trim()).filter(Boolean);
  const longestAliasesFirst = [...aliases].sort((left, right) => right.length - left.length);
  const heading = new RegExp(`^(?:${longestAliasesFirst.map(escapedRegExp).join('|')})(?:\\s*(?::|：)\\s*(.*)|\\s*)$`, 'iu');
  const output = [];
  let collecting = false;
  for (const line of lines) {
    const match = line.match(heading);
    if (match) {
      // The SAME section can appear more than once ("PRODUCTION EXPERIENCE"
      // and "ADDITIONAL EXPERIENCE" both canonicalize to Experience) —
      // every occurrence collects.
      collecting = true;
      if (match[1]?.trim()) output.push(match[1].trim());
      continue;
    }
    if (collecting && SECTION_HEADING_PATTERN.test(line)) { collecting = false; continue; }
    if (collecting) output.push(line);
    if (output.length >= 50) break;
  }
  return output;
}

function normalizedList(values, { maxItems = 40, maxLength = 100 } = {}) {
  const items = values
    // A comma INSIDE parentheses is part of the item — "Excel (Pivot Tables,
    // VLOOKUP)" is one skill, not three fragments.
    .flatMap(value => String(value || '').split(/[;|•·、；]|,(?![^()]*\))/u))
    .map(value => value.replace(/^[-*•]+\s*/u, '').trim())
    .filter(value => value.length >= 1 && value.length <= maxLength);
  return [...new Set(items)].slice(0, maxItems);
}

function structuredDescriptions(lines, maxItems = 20, { excludedValues = [] } = {}) {
  const excluded = new Set(excludedValues.map(value => String(value || '').trim()).filter(Boolean));
  return lines
    .map(line => line.replace(/^[-*•]+\s*/u, '').trim())
    .filter(line => !excluded.has(line) && !/@/.test(line))
    .filter(line => line.length >= 2 && line.length <= 500)
    .slice(0, maxItems)
    .map(description => ({ description }));
}

// Entry grouping for EXPERIENCE / PROJECTS / VOLUNTEER sections. Real resumes
// put "Company        Mon YYYY – Now" on one line, "Role      City, ST" on the
// next, then bullets. Mapping every LINE to its own entry (the old behavior)
// shredded that into heading-less one-bullet stubs with empty company/role —
// which starved the tailored resume, seniority detection, and skills matching
// all at once. Unrecognizable layouts still fall back to description-only
// entries so nothing is ever lost.
const ENTRY_BULLET_RE = /^[-*•▪‣◦·]+\s*/u;
const ENTRY_DATE_TOKEN = String.raw`(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(?:19|20)\d{2}|(?:19|20)\d{2}\s*年(?:\s*\d{1,2}\s*月)?|(?:19|20)\d{2}[./]\d{1,2}|(?:19|20)\d{2})`;
const ENTRY_DATE_RANGE_RE = new RegExp(
  `${ENTRY_DATE_TOKEN}\\s*[-–—~至到]+\\s*(?:${ENTRY_DATE_TOKEN}|now|present|current|至今|现在)`, 'iu');
const ENTRY_SEASON_RE = /\b(?:Spring|Summer|Fall|Autumn|Winter)\s+(?:19|20)\d{2}\b/iu;

// A role line's trailing "City, ST" splits off as the location. The greedy
// prefix keeps the role as long as possible, trying a two-word city
// ("San Diego, CA") before a one-word one — but a two-word "city" whose
// first word is a JOB word ("Internship Athens, GA") is role + one-word
// city, not a two-word city.
const ROLE_TAIL_WORDS = /^(?:Internship|Intern|Engineer|Manager|Assistant|Coordinator|Analyst|Director|Consultant|Specialist|Designer|Developer|Producer|Editor|Lead|Scientist|Researcher|Marketing|Sales|Usher|Grip|Gaffer|Member)$/i;
function splitRoleLocation(value) {
  const twoWordCity = value.match(/^(.*\S)\s+([A-Z][a-zA-Z.]+)\s+([A-Z][a-zA-Z.]+),\s*([A-Z]{2})$/u);
  if (twoWordCity && !ROLE_TAIL_WORDS.test(twoWordCity[2])) {
    return { role: twoWordCity[1].trim(), location: `${twoWordCity[2]} ${twoWordCity[3]}, ${twoWordCity[4]}` };
  }
  const oneWordCity = value.match(/^(.*\S)\s+([A-Z][a-zA-Z.]+,\s*[A-Z]{2})$/u);
  if (oneWordCity) return { role: oneWordCity[1].trim(), location: oneWordCity[2].trim() };
  return { role: value.trim(), location: '' };
}

// A short, capitalized, sentence-punctuation-free line may be the NEXT
// entry's role (role-first layouts) — it stays pending until the next line
// reveals which it was.
function looksLikeHeadingLine(value) {
  return value.length <= 70
    && value.split(/\s+/).length <= 8
    && !/[.;。；]\s*$/.test(value)
    && /^[A-Z\p{Script=Han}]/u.test(value);
}

function structuredEntries(lines, { excludedValues = [], maxEntries = 12 } = {}) {
  const excluded = new Set(excludedValues.map(value => String(value || '').trim()).filter(Boolean));
  const entries = [];
  let current = null;
  let pendingHeading = '';
  const startEntry = init => {
    current = { company: '', role: '', dates: '', location: '', responsibilities: [], ...init };
    entries.push(current);
  };
  // A pending heading the next line did NOT claim as its role: it belongs to
  // the current entry (its role if still open, a responsibility otherwise) or
  // opens a new date-less entry.
  const flushPending = () => {
    if (!pendingHeading) return;
    const value = pendingHeading;
    pendingHeading = '';
    if (current && !current.role && current.responsibilities.length === 0 && current.company) {
      const split = splitRoleLocation(value);
      current.role = split.role;
      if (split.location && !current.location) current.location = split.location;
    } else if (current) {
      current.responsibilities.push(value);
    } else {
      startEntry({ company: value });
    }
  };
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line || excluded.has(line) || /@/.test(line) || line.length > 500) continue;
    const isBullet = ENTRY_BULLET_RE.test(line);
    const textLine = line.replace(ENTRY_BULLET_RE, '').trim();
    if (!textLine) continue;
    const dateMatch = !isBullet && (line.match(ENTRY_DATE_RANGE_RE) || line.match(ENTRY_SEASON_RE));
    if (dateMatch) {
      // "Company … Mon YYYY - Now" (or "Project … Spring 2025") starts an entry.
      let company = line.slice(0, dateMatch.index).replace(/[|·,]+\s*$/u, '').trim();
      let role = '';
      let location = '';
      // Role-first layouts: the pending line above ("Video Production
      // Internship Athens, GA") is this entry's role, not an orphan entry.
      if (pendingHeading) {
        const split = splitRoleLocation(pendingHeading);
        role = split.role;
        location = split.location;
        pendingHeading = '';
      }
      // "Org, Role | City, ST  Mon YYYY - Present" single-heading layouts.
      if (!role && company.includes('|')) {
        const parts = company.split('|').map(part => part.trim()).filter(Boolean);
        const tail = parts[parts.length - 1];
        if (/^[A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)?,\s*[A-Z]{2}$/u.test(tail)) {
          location = tail;
          parts.pop();
        }
        company = parts.shift() || company;
        if (parts.length) role = parts.join(' | ');
      }
      if (!role) {
        const commaRole = company.match(/^(.*\S),\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})$/u);
        if (commaRole) {
          company = commaRole[1].trim();
          role = commaRole[2].trim();
        }
      }
      startEntry({ company, dates: dateMatch[0].trim(), role, location });
      continue;
    }
    if (isBullet) {
      flushPending();
      if (!current) startEntry({});
      current.responsibilities.push(textLine);
      continue;
    }
    if (!pendingHeading && current && !current.role && current.responsibilities.length === 0 && current.company) {
      // Company-first layouts: the role line right after the company+dates line.
      const split = splitRoleLocation(textLine);
      current.role = split.role;
      if (split.location) current.location = split.location;
      continue;
    }
    if (looksLikeHeadingLine(textLine)) {
      flushPending();
      pendingHeading = textLine;
      continue;
    }
    flushPending();
    if (current && current.responsibilities.length > 0) {
      // PDF wrap continuation of the previous bullet.
      const last = current.responsibilities.length - 1;
      current.responsibilities[last] = `${current.responsibilities[last]} ${textLine}`.slice(0, 500);
      continue;
    }
    if (current && (current.role || current.company)) {
      current.responsibilities.push(textLine);
      continue;
    }
    // "公司 | 职位 | 一句职责" single-line entries (common in Chinese resumes).
    if (textLine.includes('|')) {
      const parts = textLine.split('|').map(part => part.trim()).filter(Boolean);
      startEntry({
        company: parts[0] || '',
        role: parts[1] || '',
        responsibilities: parts.slice(2)
      });
      continue;
    }
    startEntry({ company: textLine });
  }
  flushPending();
  return entries
    .map(entry => ({
      company: entry.company,
      role: entry.role,
      dates: entry.dates,
      location: entry.location,
      responsibilities: entry.responsibilities.filter(Boolean).slice(0, 12)
    }))
    .filter(entry => entry.company || entry.role || entry.responsibilities.length)
    .slice(0, maxEntries);
}

function suggestion(factKey, value, confidence, evidence, extra = {}) {
  return {
    suggestion_id: `resume_suggestion_${factKey}`,
    fact_key: factKey,
    value,
    source: 'resume_document',
    source_path: 'local_resume_document',
    confidence,
    user_confirmed: false,
    status: 'review_required',
    evidence,
    sensitive: false,
    ...extra
  };
}

function likelyPhone(value) {
  for (const match of String(value || '').matchAll(/(?:^|[^\d])((?:\+?\d[\d\s().-]{7,}\d))(?!\d)/g)) {
    const candidate = match[1].trim();
    const digits = candidate.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return candidate;
  }
  return '';
}

function likelyName(lines, phone = '') {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/@|\b(?:tel|phone|mobile)\b/i.test(lines[index]) && !(phone && lines[index].includes(phone))) continue;
    for (let offset = 1; offset <= 3 && index - offset >= 0; offset += 1) {
      const candidate = lines[index - offset].trim();
      if (/^[\p{Script=Han}·]{2,6}$/u.test(candidate)) return candidate;
    }
  }
  for (const line of lines.slice(0, 6)) {
    const candidate = line.trim();
    // A name never appears BELOW the first section heading — without this
    // stop, filtering out a placeholder heading made the fallback wander
    // into the experience section and pick a role line as the name.
    if (SECTION_HEADING_PATTERN.test(candidate)) break;
    if (
      candidate.length >= 3
      && candidate.length <= 80
      && !/[@:/\\|]/.test(candidate)
      && !/\d{3,}/.test(candidate)
      && !/\b(resume|curriculum vitae|cv|profile|summary|experience|education|skills)\b/i.test(candidate)
      // Template placeholders are not names: "Name (14 pt-16 pt font)",
      // "Your Name", "First Last".
      && !/\b\d+\s*pt\b|\bfont\b|^(?:your\s+|full\s+)?name\b|^first\s+last\b/i.test(candidate)
      && !SECTION_HEADING_PATTERN.test(candidate)
      && candidate.split(/\s+/).length <= 6
    ) return candidate;
  }
  return '';
}

export function buildResumeFactSuggestions(documentText, { existingFacts = [] } = {}) {
  const normalized = canonicalizeSectionHeadings(normalizeText(documentText));
  const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  const existingKeys = new Set((Array.isArray(existingFacts) ? existingFacts : []).map(fact => fact?.fact_key));
  const candidates = [];
  const email = firstMatch(normalized, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  const linkedin = firstMatch(normalized, /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Z0-9_-]+\/?/i);
  const github = firstMatch(normalized, /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Z0-9_-]+\/?/i);
  const phone = likelyPhone(normalized);
  const fullName = likelyName(lines, phone);
  const educationLines = sectionLines(normalized, SECTION_GROUPS.education);
  const educationDescriptor = (educationLines.find(line => /本科|硕士|博士|bachelor|master|ph\.?d|degree|major/i.test(line)) || '')
    // A trailing "City, ST" merged onto the degree line by the PDF layout is
    // location, not part of the major.
    .replace(/\s+[A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)?,\s*[A-Z]{2}\s*$/u, '')
    .trim();
  // US layouts merge a trailing "Mon YYYY" (or bare year) into the school
  // line — strip it out of the institution name AND keep it as the
  // graduation date instead of losing it.
  const schoolLineRaw = educationLines[0] ? educationLines[0].split('|')[0] : '';
  const graduationMatch = schoolLineRaw.match(/\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?)?\s*((?:19|20)\d{2})\s*$/iu);
  const graduationMonth = graduationMatch?.[1]?.replace(/\.$/, '') || '';
  const graduationYear = graduationMatch?.[2] || '';
  const inferredSchool = schoolLineRaw
    ? schoolLineRaw
        .replace(/\s+(?:19|20)\d{2}[年/-].*$/u, '')
        .replace(/\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+)?(?:19|20)\d{2}\s*$/iu, '')
        .trim()
    : '';
  const inferredDegree = educationDescriptor.match(/本科|硕士|博士|Bachelor(?:'s)?|Master(?:'s)?|Ph\.?D\.?/iu)?.[0] || '';
  const inferredMajor = educationDescriptor
    ? educationDescriptor.split(/\s+(?:双学位|双专业|本科|硕士|博士|全日制|Bachelor|Master|Ph\.?D)/iu)[0].trim()
    : '';
  const school = labeledValue(normalized, ['school', 'university', 'college', '学校', '大学']) || inferredSchool;
  const degree = labeledValue(normalized, ['degree', '学历', '学位']) || inferredDegree;
  const major = labeledValue(normalized, ['major', '专业']) || inferredMajor;
  const portfolio = labeledValue(normalized, ['portfolio', 'website', 'personal website', '作品集', '个人网站']);

  // Skills lines often group items behind a label — "Editing Software: Avid,
  // Final Cut Pro". The label is a heading, not the first skill: strip it,
  // and route a "Language:"-labeled line straight to the languages fact.
  const skillLineItems = [];
  const languageLabeledItems = [];
  for (const rawLine of sectionLines(normalized, SECTION_GROUPS.skills)) {
    const line = rawLine.replace(ENTRY_BULLET_RE, '');
    const groupMatch = line.match(/^([A-Za-z&/ \p{Script=Han}]{2,30})\s*[:：]\s*(.+)$/u);
    if (groupMatch && /^languages?$|语言/iu.test(groupMatch[1].trim())) {
      languageLabeledItems.push(groupMatch[2]);
      continue;
    }
    skillLineItems.push(groupMatch ? groupMatch[2] : line);
  }
  const allSkillValues = normalizedList(skillLineItems)
    // "Microsoft Office, Windows, and MAC OS" — the list-final "and" is
    // grammar, not part of the skill.
    .map(item => item.replace(/^(?:and|以及|和)\s+/iu, ''));
  // Spoken languages listed inside the SKILLS section belong to the
  // languages fact — leaving them as "skills" polluted the Programming group.
  const LANGUAGE_ITEM_RE = /\b(?:native|professional|fluent|conversational|bilingual|proficiency|intermediate|beginner|elementary|advanced)\b|母语|流利|中文|英文|英语|日语|韩语|粤语|mandarin|cantonese|spanish|french|german|japanese|korean/iu;
  const skillValues = allSkillValues.filter(value => !LANGUAGE_ITEM_RE.test(value));
  const languagesFromSkills = allSkillValues.filter(value => LANGUAGE_ITEM_RE.test(value));
  const excludedIdentityLines = [fullName, ...lines.filter(line => (email && line.includes(email)) || (phone && line.includes(phone)))];
  const workExperience = structuredEntries(sectionLines(normalized, SECTION_GROUPS.experience), { excludedValues: excludedIdentityLines });
  const projects = structuredEntries(sectionLines(normalized, SECTION_GROUPS.projects), { excludedValues: excludedIdentityLines })
    .map(entry => ({
      name: entry.company || entry.role,
      dates: entry.dates,
      description: entry.responsibilities.join(' ').slice(0, 500),
      results: []
    }))
    .filter(entry => entry.name || entry.description);
  const volunteerExperience = structuredEntries(sectionLines(normalized, SECTION_GROUPS.volunteer), { excludedValues: excludedIdentityLines });
  const awards = normalizedList(sectionLines(normalized, SECTION_GROUPS.awards), { maxItems: 20, maxLength: 180 });
  const certifications = normalizedList(sectionLines(normalized, SECTION_GROUPS.certifications), { maxItems: 20, maxLength: 180 });
  const languageLine = labeledValue(normalized, ['languages', 'language skills', '语言', '语言能力', '语言技能']);
  const languages = normalizedList([
    ...sectionLines(normalized, SECTION_GROUPS.languages),
    languageLine,
    ...languageLabeledItems,
    ...languagesFromSkills
  ], { maxItems: 20, maxLength: 100 });
  const summary = sectionLines(normalized, SECTION_GROUPS.summary).join(' ').slice(0, 1200);
  const yearsExperience = firstMatch(normalized, /\b\d+(?:\.\d+)?\+?\s+years?\s+(?:of\s+)?experience\b/i)
    .match(/\d+(?:\.\d+)?\+?/)?.[0] || '';

  if (fullName) candidates.push(suggestion('full_name', fullName, 0.6, 'first_resume_heading'));
  if (email) candidates.push(suggestion('email', email, 0.99, 'email_pattern'));
  if (phone) candidates.push(suggestion('phone', phone, 0.85, 'phone_pattern'));
  if (linkedin) candidates.push(suggestion('linkedin', linkedin, 0.98, 'linkedin_url'));
  if (github) candidates.push(suggestion('github', github, 0.98, 'github_url'));
  if (portfolio) candidates.push(suggestion('portfolio', portfolio, 0.8, 'labeled_portfolio'));
  if (school) candidates.push(suggestion('school', school, 0.75, 'labeled_school'));
  if (degree) candidates.push(suggestion('degree', degree, 0.75, 'labeled_degree'));
  if (major) candidates.push(suggestion('major', major, 0.75, 'labeled_major'));
  if (graduationYear) candidates.push(suggestion('graduation_year', graduationYear, 0.7, 'school_line_date'));
  if (graduationMonth) candidates.push(suggestion('graduation_month', graduationMonth, 0.7, 'school_line_date'));
  if (summary) candidates.push(suggestion('summary', summary, 0.65, 'summary_section'));
  if (yearsExperience) candidates.push(suggestion('years_experience', yearsExperience, 0.7, 'years_experience_pattern'));
  if (workExperience.length) candidates.push(suggestion('work_experience', workExperience, 0.65, 'work_experience_section'));
  if (projects.length) candidates.push(suggestion('projects', projects, 0.65, 'projects_section'));
  if (volunteerExperience.length) candidates.push(suggestion('volunteer_experience', volunteerExperience, 0.65, 'volunteer_section'));
  if (skillValues.length) candidates.push(suggestion('skills', skillValues, 0.8, 'skills_section'));
  if (awards.length) candidates.push(suggestion('awards', awards, 0.75, 'awards_section'));
  if (certifications.length) candidates.push(suggestion('certifications', certifications, 0.75, 'certifications_section'));
  if (languages.length) candidates.push(suggestion('languages', languages, 0.75, 'languages_section'));

  return candidates.map(item => ({
    ...item,
    existing_fact_present: existingKeys.has(item.fact_key)
  }));
}

export function analyzeResumeDocument({
  content,
  fileName,
  contentHash = '',
  existingFacts = []
} = {}) {
  const extracted = extractResumeDocumentText(content, { fileName });
  const suggestions = buildResumeFactSuggestions(extracted.text, { existingFacts });
  const textHash = `sha256:${crypto.createHash('sha256').update(extracted.text).digest('hex')}`;
  const snapshotToken = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    content_hash: contentHash,
    text_hash: textHash,
    suggestions: suggestions.map(item => ({
      fact_key: item.fact_key,
      value: item.value,
      confidence: item.confidence,
      evidence: item.evidence
    }))
  })).digest('hex')}`;
  return {
    schema_version: '1.0',
    analysis_mode: 'explicit_local_preview',
    format: extracted.format,
    extraction_method: extracted.extraction_method,
    extracted_character_count: extracted.text.length,
    text_hash: textHash,
    raw_text_included: false,
    suggestions,
    summary: {
      suggestion_count: suggestions.length,
      new_fact_suggestion_count: suggestions.filter(item => !item.existing_fact_present).length,
      existing_fact_conflict_count: suggestions.filter(item => item.existing_fact_present).length,
      review_required_count: suggestions.length
    },
    warnings: extracted.warnings,
    snapshot_token: snapshotToken,
    persistence: {
      raw_text_saved: false,
      suggestions_saved: false,
      candidate_profile_modified: false,
      resume_profile_modified: false
    }
  };
}

export async function analyzeResumeDocumentRobust({
  content,
  fileName,
  contentHash = '',
  existingFacts = []
} = {}) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  const extracted = extension === '.pdf'
    ? await extractPdfTextRobust(content)
    : extractResumeDocumentText(content, { fileName });
  const suggestions = buildResumeFactSuggestions(extracted.text, { existingFacts });
  if (!suggestions.length) {
    analysisError(
      'NO_REVIEWABLE_FACTS',
      'Text was extracted, but no reviewable identity, education, experience, project, skill, or language facts were found.'
    );
  }
  const textHash = `sha256:${crypto.createHash('sha256').update(extracted.text).digest('hex')}`;
  const snapshotToken = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    content_hash: contentHash,
    text_hash: textHash,
    suggestions: suggestions.map(item => ({
      fact_key: item.fact_key,
      value: item.value,
      confidence: item.confidence,
      evidence: item.evidence
    }))
  })).digest('hex')}`;
  const result = {
    schema_version: '1.0',
    analysis_mode: 'explicit_local_preview',
    format: extracted.format,
    extraction_method: extracted.extraction_method,
    extracted_character_count: extracted.text.length,
    text_hash: textHash,
    raw_text_included: false,
    suggestions,
    summary: {
      suggestion_count: suggestions.length,
      new_fact_suggestion_count: suggestions.filter(item => !item.existing_fact_present).length,
      existing_fact_conflict_count: suggestions.filter(item => item.existing_fact_present).length,
      review_required_count: suggestions.length
    },
    warnings: extracted.warnings,
    snapshot_token: snapshotToken,
    persistence: {
      raw_text_saved: false,
      suggestions_saved: false,
      candidate_profile_modified: false,
      resume_profile_modified: false
    }
  };
  Object.defineProperty(result, 'transient_text', {
    value: extracted.text,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return result;
}

export const RESUME_DOCUMENT_LIMITS = Object.freeze({
  max_document_bytes: MAX_DOCUMENT_BYTES,
  max_decompressed_entry_bytes: MAX_DECOMPRESSED_ENTRY_BYTES,
  max_decompressed_total_bytes: MAX_DECOMPRESSED_TOTAL_BYTES,
  max_text_chars: MAX_TEXT_CHARS
});
