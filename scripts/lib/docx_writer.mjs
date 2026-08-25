// A minimal, dependency-free DOCX writer for tailored resumes.
//
// Scope is deliberately narrow: one document type (a professional resume),
// produced from the render model in resume_render.mjs. That narrowness is what
// lets ~300 lines of hand-written OOXML replace a document library — the
// project's only runtime dependency today is a PDF reader, and a resume
// template does not justify a second one.
//
// The ZIP container uses STORE (no compression): simplest valid form, and the
// same reader this repo already uses for uploaded resumes
// (resume_document_intelligence.readZipDirectory) reads it back — which the
// tests exploit to verify every generated file's actual text content.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Builds a STORE-method ZIP from {name, data} entries.
export function createZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
    local.writeUInt16LE(0, 8);           // method: STORE
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x2100, 12);     // mod date (a fixed, valid date)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2100, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra/comment/disk/attrs stay zero.
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBytes, data);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

// --- OOXML ------------------------------------------------------------------

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// One paragraph. All formatting is direct so the document renders identically
// in Word, WPS and LibreOffice without relying on style inheritance.
function paragraph(runs, {
  spacingBefore = 0, spacingAfter = 120, bottomBorder = false, indentLeft = 0
} = {}) {
  const border = bottomBorder
    ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="444444"/></w:pBdr>'
    : '';
  const indent = indentLeft ? `<w:ind w:left="${indentLeft}" w:hanging="160"/>` : '';
  const runXml = runs.map(run => {
    const props = [
      run.bold ? '<w:b/>' : '',
      run.italic ? '<w:i/>' : '',
      run.caps ? '<w:caps/>' : '',
      `<w:sz w:val="${(run.size || 21)}"/>`,
      run.color ? `<w:color w:val="${run.color}"/>` : ''
    ].join('');
    return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
  }).join('');
  return `<w:p><w:pPr>${border}${indent}`
    + `<w:spacing w:before="${spacingBefore}" w:after="${spacingAfter}"/>`
    + `</w:pPr>${runXml}</w:p>`;
}

// The professional resume layout: name, contact line, bordered section
// headings, entry headings with dates, hanging-indent bullets.
function documentXml(model) {
  const parts = [];

  parts.push(paragraph([{ text: model.name || '', bold: true, size: 40 }], { spacingAfter: 40 }));
  if (model.contact_line) {
    parts.push(paragraph([{ text: model.contact_line, size: 18, color: '555555' }], { spacingAfter: 200 }));
  }

  for (const section of model.sections) {
    parts.push(paragraph(
      [{ text: section.title, bold: true, caps: true, size: 22 }],
      { spacingBefore: 200, spacingAfter: 80, bottomBorder: true }
    ));
    for (const line of section.lines || []) {
      parts.push(paragraph([{ text: line, size: 21 }], { spacingAfter: 60 }));
    }
    for (const entry of section.entries || []) {
      const headingRuns = [{ text: entry.heading, bold: true, size: 21 }];
      if (entry.dates) headingRuns.push({ text: `   ${entry.dates}`, italic: true, size: 19, color: '555555' });
      parts.push(paragraph(headingRuns, { spacingBefore: 100, spacingAfter: 30 }));
      if (entry.subheading) {
        parts.push(paragraph([{ text: entry.subheading, italic: true, size: 20, color: '333333' }], { spacingAfter: 40 }));
      }
      for (const bullet of entry.bullets || []) {
        parts.push(paragraph([{ text: `•  ${bullet}`, size: 21 }], { spacingAfter: 40, indentLeft: 340 }));
      }
    }
  }

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${parts.join('')}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>'
    + '</w:body></w:document>';
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" '
  + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" '
  + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '</Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" '
  + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
  + 'Target="word/document.xml"/>'
  + '</Relationships>';

const DOCUMENT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" '
  + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
  + 'Target="styles.xml"/>'
  + '</Relationships>';

// Default font with a CJK-capable fallback, so a profile written in Chinese
// renders instead of tofu-boxing.
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:docDefaults><w:rPrDefault><w:rPr>'
  + '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/>'
  + '<w:sz w:val="21"/>'
  + '</w:rPr></w:rPrDefault></w:docDefaults>'
  + '</w:styles>';

export function buildResumeDocx(model) {
  return createZipArchive([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/_rels/document.xml.rels', data: DOCUMENT_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/document.xml', data: documentXml(model) }
  ]);
}
