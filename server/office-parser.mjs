// SPDX-License-Identifier: MIT
// Read OOXML as data only: no Office engine, file extraction, formulas or external requests.
import * as yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { posix } from 'node:path';
import { crc32 } from 'node:zlib';
const MiB = 1024 * 1024;
const fail = (message) => {
  throw new Error(message);
};
async function readPackage(bytes) {
  if (bytes.length > 8 * MiB) fail('Use an Office file of up to 8 MB.');
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
    fail(
      'This is not a readable DOCX, XLSX or PPTX file. Password-protected and older Office files need an unlocked modern-format copy.',
    );
  const zip = await yauzl.fromBufferPromise(bytes, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  const entries = new Set(),
    parts = new Map();
  let declared = 0,
    xmlBytes = 0;
  try {
    if (zip.entryCount > 3000) fail('This Office file contains too many parts to preview.');
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (entries.has(name)) fail('This Office file has duplicate parts.');
      entries.add(name);
      if (entry.generalPurposeBitFlag & 1) fail('Unlock the Office file before attaching it.');
      if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
        fail('This Office file contains an unsupported link.');
      declared += entry.uncompressedSize;
      if (entry.uncompressedSize > 16 * MiB || declared > 64 * MiB)
        fail('This Office file expands beyond the preview limit.');
      if (!/\.(xml|rels)$/i.test(name)) continue;
      xmlBytes += entry.uncompressedSize;
      if (xmlBytes > 16 * MiB) fail('This Office file contains too much text to preview.');
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      let length = 0;
      for await (const chunk of stream) {
        length += chunk.length;
        if (length > entry.uncompressedSize || length > 16 * MiB) {
          stream.destroy();
          fail('An Office part exceeds its declared size.');
        }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      if (crc32(data) !== entry.crc32) fail('This Office file has damaged content.');
      // OOXML may be UTF-16. Decode only explicitly supported XML encodings.
      let text;
      if (data[0] === 0xff && data[1] === 0xfe)
        text = new TextDecoder('utf-16le', { fatal: true }).decode(data);
      else if (data[0] === 0xfe && data[1] === 0xff)
        text = new TextDecoder('utf-16be', { fatal: true }).decode(data);
      else text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      parts.set(name, text);
    }
  } finally {
    zip.close();
  }
  return parts;
}
function xml(source) {
  if (!source) fail('A required Office part is missing.');
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  let root,
    count = 0;
  parser.on('doctype', () => fail('Office XML with a document type is not supported.'));
  parser.on('opentag', (tag) => {
    if (++count > 300000 || stack.length > 96) fail('The Office XML is too complex to preview.');
    const node = { name: tag.local, ns: tag.uri, attrs: tag.attributes, children: [] };
    if (stack.length) stack.at(-1).children.push(node);
    else root = node;
    stack.push(node);
  });
  const text = (value) => {
    if (stack.length) stack.at(-1).children.push(value);
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => stack.pop());
  parser.write(source).close();
  return root;
}
const relationId = (node) =>
  Object.values(node?.attrs || {}).find(
    (a) => a.local === 'id' && a.uri?.endsWith('/relationships'),
  )?.value;
const attr = (node, key) => Object.values(node?.attrs || {}).find((a) => a.local === key)?.value;
const nodes = (node, name) =>
  (node?.children || []).filter((c) => typeof c !== 'string' && (!name || c.name === name));
const content = (node) =>
  (node?.children || []).map((c) => (typeof c === 'string' ? c : content(c))).join('');
function* descendants(node, name) {
  for (const child of nodes(node)) {
    if (child.name === name) yield child;
    yield* descendants(child, name);
  }
}
function relationshipPart(part) {
  return posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
}
function relationships(parts, part = '') {
  const source = parts.get(part ? relationshipPart(part) : '_rels/.rels');
  if (!source) return [];
  return nodes(xml(source), 'Relationship').map((n) => {
    const target = attr(n, 'Target') || '';
    const external = attr(n, 'TargetMode') === 'External';
    let path;
    if (!external) {
      if (
        /[\\\u0000]/.test(target) ||
        /^[a-z][a-z0-9+.-]*:/i.test(target) ||
        target.includes('?') ||
        target.includes('#')
      )
        fail('An Office part has an invalid target.');
      let decoded;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        fail('An Office part has an invalid target.');
      }
      path = posix.normalize(
        target.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(part), decoded),
      );
      if (path.startsWith('../') || path === '..' || path.startsWith('/') || path.includes('\\'))
        fail('An Office part points outside its package.');
    }
    return { id: attr(n, 'Id'), type: attr(n, 'Type')?.split('/').at(-1), path, target, external };
  });
}
function related(parts, part, id, type) {
  const relation = relationships(parts, part).find((r) => r.id === id && r.type === type);
  if (!relation || relation.external || !parts.has(relation.path))
    fail('A required Office relationship is missing or external.');
  return relation.path;
}
function wordText(node, links) {
  if (typeof node === 'string') return '';
  if (['del', 'moveFrom', 'instrText', 'delText'].includes(node.name)) return '';
  if (node.name === 't') return content(node);
  if (node.name === 'tab') return '\t';
  if (['br', 'cr'].includes(node.name)) return '\n';
  if (node.name === 'docPr')
    return attr(node, 'descr') ? `[Image description: ${attr(node, 'descr')}]` : '[Image]';
  let text = nodes(node)
    .map((n) => wordText(n, links))
    .join('');
  if (node.name === 'hyperlink') {
    const link = links.find((r) => r.id === relationId(node) && r.type === 'hyperlink');
    if (link?.external) text += ` (${link.target})`;
  }
  if (node.name === 'p') text += '\n';
  if (node.name === 'tc') text = text.trimEnd() + '\t';
  if (node.name === 'tr') text = text.trimEnd() + '\n';
  return text;
}
function richText(node) {
  if (['rPh', 'phoneticPr'].includes(node?.name)) return '';
  if (node?.name === 't') return content(node);
  return nodes(node).map(richText).join('');
}
function drawingText(root) {
  return [...descendants(root, 'p')]
    .map((p) => {
      const walk = (node) =>
        node.name === 't'
          ? content(node)
          : node.name === 'br'
            ? '\n'
            : nodes(node).map(walk).join('');
      return walk(p);
    })
    .filter(Boolean)
    .join('\n');
}
export async function parseOffice(bytes, kind) {
  const parts = await readPackage(Buffer.from(bytes));
  const main = relationships(parts).find((r) => r.type === 'officeDocument');
  if (!main || main.external || !parts.has(main.path))
    fail('The Office document entry point is missing.');
  const root = xml(parts.get(main.path));
  const expected = {
    document: 'wordprocessingml',
    spreadsheet: 'spreadsheetml',
    presentation: 'presentationml',
  }[kind];
  if (!expected || !root.ns?.includes(`/${expected}/`))
    fail('The Office file format does not match its name or type.');
  const sections = [];
  const warnings = new Set();
  let length = 0;
  function add(title, text) {
    text = text.replace(/\n{4,}/g, '\n\n\n').trim();
    length += title.length + text.length + 8;
    if (length > 500000 || sections.length >= 1000)
      fail('This file exceeds the text preview limit. Split it into smaller files.');
    if (text) sections.push({ title, text });
  }
  warnings.add(
    'Text preview only. Page layout, images, charts and embedded objects are not rendered. Download the original for the complete file.',
  );
  if ([...parts.keys()].some((p) => /vba|externalLinks|embeddings/i.test(p)))
    warnings.add('Embedded content and external sources are not opened or executed.');
  if (kind === 'document') {
    add('Document', wordText(root, relationships(parts, main.path)));
    for (const relation of relationships(parts, main.path)) {
      if (
        !relation.external &&
        ['header', 'footer', 'footnotes', 'endnotes', 'comments'].includes(relation.type)
      ) {
        if (!parts.has(relation.path)) fail('A document text part is missing.');
        add(
          relation.type,
          wordText(xml(parts.get(relation.path)), relationships(parts, relation.path)),
        );
      }
    }
    if ([...descendants(root, 'del')].length || [...descendants(root, 'moveFrom')].length)
      warnings.add('Tracked deletions and moved-from text are omitted. Inserted text is included.');
  } else if (kind === 'presentation') {
    const slides = [...descendants(root, 'sldId')];
    if (slides.length > 500) fail('Use a presentation with up to 500 slides.');
    for (const [i, slide] of slides.entries()) {
      const path = related(parts, main.path, relationId(slide), 'slide');
      const body = xml(parts.get(path));
      add(`Slide ${i + 1}${attr(body, 'show') === '0' ? ' (hidden)' : ''}`, drawingText(body));
      const notes = relationships(parts, path).find((r) => r.type === 'notesSlide');
      if (notes) {
        if (notes.external || !parts.has(notes.path)) fail('Slide notes are missing or external.');
        // Slide-number/footer placeholders are not speaker notes.
        const noteRoot = xml(parts.get(notes.path));
        const noteText = [...descendants(noteRoot, 'sp')]
          .filter((sp) => {
            const ph = [...descendants(sp, 'ph')][0];
            return !ph || !['sldNum', 'hdr', 'ftr', 'dt', 'sldImg'].includes(attr(ph, 'type'));
          })
          .map(drawingText)
          .filter(Boolean)
          .join('\n');
        add(`Slide ${i + 1} · Speaker notes`, noteText);
      }
    }
  } else {
    const links = relationships(parts, main.path);
    const shared = links.find((r) => r.type === 'sharedStrings');
    const strings =
      shared && !shared.external ? nodes(xml(parts.get(shared.path)), 'si').map(richText) : [];
    const styles = links.find((r) => r.type === 'styles');
    const styleRoot = styles && !styles.external ? xml(parts.get(styles.path)) : null;
    const formats = new Map(
      [...descendants(styleRoot, 'numFmt')].map((n) => [
        attr(n, 'numFmtId'),
        attr(n, 'formatCode'),
      ]),
    );
    const styleIds = nodes(nodes(styleRoot, 'cellXfs')[0], 'xf').map((n) => attr(n, 'numFmtId'));
    const sheets = [...descendants(root, 'sheet')];
    if (sheets.length > 100) fail('Use a workbook with up to 100 sheets.');
    const date1904 = [...descendants(root, 'workbookPr')].some((n) =>
      ['1', 'true'].includes(attr(n, 'date1904')),
    );
    warnings.add(
      `Formulas are shown without execution; saved results may be out of date. Numeric values use raw stored values (Excel ${date1904 ? '1904' : '1900'} date system). Number formats are included when available.`,
    );
    let cellCount = 0;
    for (const sheet of sheets) {
      const path = related(parts, main.path, relationId(sheet), 'worksheet');
      const sheetRoot = xml(parts.get(path));
      const rows = [];
      for (const row of descendants(sheetRoot, 'row')) {
        const cells = [];
        for (const cell of nodes(row, 'c')) {
          if (++cellCount > 100000) fail('Use a workbook with up to 100,000 populated cells.');
          const ref = attr(cell, 'r');
          if (!ref || !/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(ref))
            fail('A spreadsheet cell has an invalid address.');
          const raw = content(nodes(cell, 'v')[0]);
          const type = attr(cell, 't');
          let value = raw;
          if (type === 's') {
            if (!/^\d+$/.test(raw) || strings[Number(raw)] === undefined)
              fail('A spreadsheet shared string is missing.');
            value = strings[Number(raw)];
          } else if (type === 'inlineStr') value = richText(cell);
          else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
          const formula = nodes(cell, 'f')[0];
          if (formula) {
            const sharedFormula = attr(formula, 't') === 'shared';
            value = `Formula: ${content(formula) ? '=' + content(formula) : '(shared/array expression in another cell)'}${sharedFormula ? ` [shared ${attr(formula, 'si') || ''}]` : ''}; saved result: ${value || '(not saved)'}`;
          } else if (['s', 'inlineStr', 'str', 'e'].includes(type)) value = JSON.stringify(value);
          const style = attr(cell, 's');
          const formatId = style === undefined ? undefined : styleIds[Number(style)];
          const format =
            formatId && formatId !== '0'
              ? ` [format ${formats.get(formatId) || 'built-in ' + formatId}]`
              : '';
          cells.push(`${ref}: ${value}${format}`);
        }
        if (cells.length) rows.push(cells.join(' | '));
      }
      add(
        `Sheet: ${attr(sheet, 'name') || '(unnamed)'}${attr(sheet, 'state') && attr(sheet, 'state') !== 'visible' ? ' (hidden)' : ''}`,
        rows.join('\n'),
      );
    }
  }
  if (!sections.length)
    warnings.add('No readable text was found. The file may contain only images or empty pages.');
  return { kind, sections, warnings: [...warnings] };
}
