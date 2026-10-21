// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import {
  normalizeArtifact,
  artifactKinds,
  artifactVersion,
  calculateSheet,
  columnName,
  previewHtml,
} from '../shared/artifacts.mjs';
import { uid, iso } from '../shared/seed.mjs';
import { parseCsv } from '../shared/finance.mjs';
import { artifactHtmlCheck } from './artifact-html.mjs';

// Keep the storage/API source format stable while avoiding double-encoded JSON
// in model tool calls. Never silently choose between conflicting representations.
export function artifactToolInput(input, state) {
  if (Object.hasOwn(input, 'edits')) {
    if (['source', 'sheets', 'slides', 'csv', 'sheetName'].some((key) => Object.hasOwn(input, key)))
      throw new Error('Supply edits alone, without source, sheets, slides or csv.');
    if (!input.id || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
      throw new Error(
        'Read the saved result, then supply its id and current expectedVersion for edits.',
      );
    const { artifact, version } = artifactVersion(state, input.id, input.expectedVersion);
    if (
      (input.kind && input.kind !== artifact.kind) ||
      (input.title && input.title !== version.title)
    )
      throw new Error(
        'Exact edits keep the existing kind and title. Use a complete source to rename a result.',
      );
    if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 20)
      throw new Error('Supply between 1 and 20 exact edits.');
    let source = version.source;
    for (const edit of input.edits) {
      if (
        !edit ||
        typeof edit.find !== 'string' ||
        !edit.find.length ||
        edit.find.length > 200000 ||
        typeof edit.replace !== 'string' ||
        edit.replace.length > 200000 ||
        edit.find === edit.replace
      )
        throw new Error(
          'Each edit needs nonempty find text and different replacement text, up to 200,000 characters each.',
        );
      const index = source.indexOf(edit.find);
      if (index < 0)
        throw new Error(
          'Edit text was not found. Read the saved source and copy the exact text to change.',
        );
      if (source.indexOf(edit.find, index + 1) >= 0)
        throw new Error(
          'Edit text matches more than once. Include surrounding text to identify one place.',
        );
      source = source.slice(0, index) + edit.replace + source.slice(index + edit.find.length);
      if (source.length > 200000) throw new Error('Edited content exceeds 200,000 characters.');
    }
    const prepared = {
      id: input.id,
      expectedVersion: input.expectedVersion,
      kind: artifact.kind,
      title: version.title,
      source,
    };
    normalizeArtifact(prepared);
    return prepared;
  }
  const hasSheets = Object.hasOwn(input, 'sheets');
  const hasSlides = Object.hasOwn(input, 'slides');
  const hasCsv = Object.hasOwn(input, 'csv');
  if ((hasCsv || Object.hasOwn(input, 'sheetName')) && input.kind !== 'spreadsheet')
    throw new Error('csv and sheetName are only for kind spreadsheet.');
  if (Object.hasOwn(input, 'sheetName') && !hasCsv)
    throw new Error('sheetName requires csv. Use names inside sheets for structured rows.');
  if (hasSheets && input.kind !== 'spreadsheet')
    throw new Error('sheets is only for kind spreadsheet.');
  if (hasSlides && input.kind !== 'presentation')
    throw new Error('slides is only for kind presentation.');
  if ([hasSheets, hasSlides, hasCsv, Object.hasOwn(input, 'source')].filter(Boolean).length > 1)
    throw new Error('Supply exactly one content format: source, csv, sheets or slides.');
  const key =
    input.kind === 'spreadsheet' ? 'sheets' : input.kind === 'presentation' ? 'slides' : null;
  const prepared = {
    ...input,
    ...(hasSheets || hasSlides ? { source: JSON.stringify({ [key]: input[key] }) } : {}),
  };
  try {
    if (hasCsv) {
      if (typeof input.csv !== 'string' || input.csv.length > 200000)
        throw new Error('Use CSV text up to 200,000 characters.');
      const rows = parseCsv(input.csv).map((row) =>
        row.map((cell) => {
          if (cell.startsWith("'")) return cell.slice(1);
          if (cell.startsWith('=')) return { formula: cell.slice(1) };
          // Preserve codes such as 00123 and long identifiers rather than rounding them.
          if (
            /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cell) &&
            cell.replace(/\D/g, '').length <= 15 &&
            Number.isFinite(Number(cell))
          )
            return Number(cell);
          return cell;
        }),
      );
      prepared.source = JSON.stringify({ sheets: [{ name: input.sheetName ?? 'Sheet1', rows }] });
    }
    normalizeArtifact(prepared);
  } catch (error) {
    const hint =
      input.kind === 'spreadsheet'
        ? ' For a simple sheet, supply csv text such as Item,Amount\nTrain,25\nTotal,=SUM(B2:B2). Otherwise supply sheets with each row an array of cells. Correct the arguments and retry.'
        : key
          ? ` Supply ${key} as a structured array in save_artifact, not a JSON-encoded string; follow its schema and retry.`
          : ' Supply source as direct Markdown for document, or HTML for web.';
    throw new Error(error.message + hint);
  }
  delete prepared.sheets;
  delete prepared.slides;
  delete prepared.csv;
  delete prepared.sheetName;
  return prepared;
}

// Bounded semantic feedback lets the model inspect the saved result instead of
// interpreting a successful export as proof that the user's content is correct.
export function artifactContentCheck(kind, source) {
  if (kind === 'spreadsheet') {
    const sheets = JSON.parse(source).sheets;
    return {
      sheetCount: sheets.length,
      omittedSheets: Math.max(0, sheets.length - 3),
      sheets: sheets.slice(0, 3).map((sheet) => {
        const values = calculateSheet(sheet.rows);
        const columns = sheet.rows[0].length;
        const unevenRows = sheet.rows.flatMap((row, index) =>
          row.length === columns ? [] : [index + 1],
        );
        const formulas = [];
        const literalFormulas = [];
        sheet.rows.forEach((row, r) =>
          row.forEach((cell, c) => {
            const address = `${columnName(c)}${r + 1}`;
            if (cell && typeof cell === 'object' && typeof cell.formula === 'string')
              formulas.push({ cell: address, formula: cell.formula, value: values[r][c] });
            else if (typeof cell === 'string' && cell.trimStart().startsWith('='))
              literalFormulas.push(address);
          }),
        );
        const warnings = [
          ...(unevenRows.length
            ? [
                `Rows ${unevenRows.slice(0, 20).join(', ')} have a different cell count from the first row. Check labels, empty cells and column alignment; revise if unintended.`,
              ]
            : []),
          ...(literalFormulas.length
            ? [
                `Cells ${literalFormulas.slice(0, 20).join(', ')} contain text starting with =, not executable formulas. If calculations were intended, revise them using {"formula":"SUM(B2:B4)"} cells or csv with leading = formulas. Keep them as text only when literal text was intended.`,
              ]
            : []),
        ];
        return {
          name: sheet.name,
          rowCount: sheet.rows.length,
          headerColumns: columns,
          formulaCount: formulas.length,
          formulas: formulas.slice(0, 8),
          omittedFormulas: Math.max(0, formulas.length - 8),
          literalFormulaCount: literalFormulas.length,
          previewTruncated:
            sheet.rows.length > 8 ||
            sheet.rows.some(
              (row) =>
                row.length > 8 ||
                row.some((value) => typeof value === 'string' && value.length > 96),
            ),
          preview: values
            .slice(0, 8)
            .map((row) =>
              row
                .slice(0, 8)
                .map((value) => (typeof value === 'string' ? value.slice(0, 96) : value)),
            ),
          ...(warnings.length ? { warning: warnings.join(' ') } : {}),
        };
      }),
    };
  }
  if (kind === 'presentation') {
    const slides = JSON.parse(source).slides;
    return {
      slideCount: slides.length,
      slides: slides.map((s, index) => ({
        number: index + 1,
        title: s.title,
        bulletCount: s.bullets.length,
        hasNotes: !!s.notes.trim(),
      })),
    };
  }
  if (kind === 'web') {
    let syntaxCheck;
    try {
      syntaxCheck = { status: 'passed', ...artifactHtmlCheck(source) };
    } catch (error) {
      // A receipt replay can refer to a legacy result saved before syntax checks.
      // Report its defect without claiming that an existing file was not saved.
      syntaxCheck = { status: 'failed', error: error.message };
    }
    return {
      syntaxCheck,
      excerpt: source.slice(0, 12000),
      truncated: source.length > 12000,
      previewEnvironment:
        'Scripts run in an opaque-origin sandbox with network, external resources and persistent browser storage unavailable. Use in-memory state and accessible control names matching the request. Check the actual event handlers, initial state, updates and reset behavior; a file export does not prove that its JavaScript works.',
    };
  }
  return { excerpt: source.slice(0, 1200), truncated: source.length > 1200 };
}

async function documentBytes(source, title) {
  const [{ unified }, { default: parse }, { default: gfm }, d] = await Promise.all([
    import('unified'),
    import('remark-parse'),
    import('remark-gfm'),
    import('docx'),
  ]);
  const tree = unified().use(parse).use(gfm).parse(source);
  let count = 0;
  function check(node, depth = 0) {
    if (++count > 12000 || depth > 24)
      throw new Error('The document is too complex. Use fewer nested blocks.');
    for (const child of node.children || []) check(child, depth + 1);
  }
  check(tree);
  const plain = (node) => node.value ?? node.alt ?? (node.children || []).map(plain).join('');
  function inline(nodes, style = {}) {
    return nodes.flatMap((n) => {
      if (n.type === 'strong') return inline(n.children, { ...style, bold: true });
      if (n.type === 'emphasis') return inline(n.children, { ...style, italics: true });
      if (n.type === 'delete') return inline(n.children, { ...style, strike: true });
      if (n.type === 'break') return [new d.TextRun({ break: 1 })];
      if (n.type === 'link' && /^https?:\/\//i.test(n.url))
        return [
          new d.ExternalHyperlink({
            link: n.url,
            children: inline(n.children, { ...style, color: '27685A', underline: {} }),
          }),
        ];
      if (n.type === 'image')
        return [new d.TextRun({ ...style, text: `[Image: ${n.alt || ''}] ${n.url || ''}` })];
      return [
        new d.TextRun({
          ...style,
          text: plain(n),
          ...(n.type === 'inlineCode' ? { font: 'Consolas' } : {}),
        }),
      ];
    });
  }
  const numbering = [];
  function blocks(nodes, level = 0) {
    return nodes.flatMap((n) => {
      const spacing = { after: 180, line: 300 };
      if (n.type === 'heading')
        return [
          new d.Paragraph({
            heading: d.HeadingLevel[`HEADING_${n.depth}`],
            children: inline(n.children),
            spacing: { before: 280, after: 160 },
          }),
        ];
      if (n.type === 'table')
        return [
          new d.Table({
            width: { size: 100, type: d.WidthType.PERCENTAGE },
            rows: n.children.map(
              (row, index) =>
                new d.TableRow({
                  tableHeader: index === 0,
                  children: row.children.map(
                    (cell) =>
                      new d.TableCell({
                        shading: index === 0 ? { fill: 'EAF2EE' } : undefined,
                        children: [
                          new d.Paragraph({
                            children: inline(cell.children, { bold: index === 0 }),
                            spacing,
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          }),
        ];
      if (n.type === 'list') {
        const reference = `list-${numbering.length}`;
        if (n.ordered)
          numbering.push({
            reference,
            levels: [
              {
                level: 0,
                format: d.LevelFormat.DECIMAL,
                text: '%1.',
                start: n.start || 1,
                alignment: d.AlignmentType.START,
                style: { paragraph: { indent: { left: 720 + level * 360, hanging: 300 } } },
              },
            ],
          });
        return n.children.flatMap((item) =>
          item.children.flatMap((child, index) =>
            child.type === 'list'
              ? blocks([child], level + 1)
              : [
                  new d.Paragraph({
                    children: inline(child.children || [{ type: 'text', value: plain(child) }]),
                    spacing,
                    ...(index === 0
                      ? n.ordered
                        ? { numbering: { reference, level: 0 } }
                        : { bullet: { level: Math.min(level, 8) } }
                      : {}),
                  }),
                ],
          ),
        );
      }
      if (n.type === 'code')
        return n.value.split('\n').map(
          (line) =>
            new d.Paragraph({
              children: [new d.TextRun({ text: line || ' ', font: 'Consolas', size: 20 })],
              spacing: { after: 0, line: 260 },
            }),
        );
      if (n.type === 'blockquote') return blocks(n.children, level);
      if (n.type === 'thematicBreak') return [new d.Paragraph({ text: '─────', spacing })];
      if (n.type === 'definition')
        return [new d.Paragraph({ text: `[${n.label || n.identifier}]: ${n.url}`, spacing })];
      return [
        new d.Paragraph({
          children: inline(n.children || [{ type: 'text', value: plain(n) }]),
          spacing,
        }),
      ];
    });
  }
  const children = blocks(tree.children);
  const doc = new d.Document({
    creator: 'Relay',
    title,
    styles: { default: { document: { run: { font: 'Aptos', size: 22, color: '21382F' } } } },
    numbering: { config: numbering },
    sections: [{ children }],
  });
  return d.Packer.toBuffer(doc);
}
async function spreadsheetBytes(source, title) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Relay';
  workbook.title = title;
  workbook.calcProperties.fullCalcOnLoad = true;
  for (const sheet of JSON.parse(source).sheets) {
    const out = workbook.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    const values = calculateSheet(sheet.rows);
    sheet.rows.forEach((row, r) => {
      out.addRow(
        row.map((value, c) =>
          value && typeof value === 'object'
            ? { formula: value.formula, result: values[r][c] }
            : value,
        ),
      );
    });
    out.columns.forEach((col) => {
      col.width = 24;
    });
    out.eachRow((row, index) => {
      row.eachCell((cell) => {
        cell.font = { name: 'Aptos', size: 11, color: { argb: 'FF21382F' }, bold: index === 1 };
        cell.alignment = { vertical: 'top', wrapText: true };
        if (index === 1)
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2EE' } };
      });
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
async function presentationBytes(source, title) {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const ppt = new PptxGenJS();
  ppt.layout = 'LAYOUT_WIDE';
  ppt.author = 'Relay';
  ppt.subject = title;
  ppt.title = title;
  ppt.company = 'Relay';
  ppt.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'en-US' };
  JSON.parse(source).slides.forEach((data, index) => {
    const slide = ppt.addSlide();
    slide.background = { color: 'FAF8F2' };
    slide.addText(title, {
      x: 0.65,
      y: 0.35,
      w: 11,
      h: 0.3,
      fontSize: 11,
      color: '53685F',
      margin: 0,
    });
    slide.addText(data.title, {
      x: 0.65,
      y: 1.0,
      w: 12,
      h: 1.1,
      fontSize: 32,
      bold: true,
      color: '21382F',
      margin: 0,
      breakLine: false,
      fit: 'shrink',
    });
    if (data.bullets.length)
      slide.addText(
        data.bullets.map((text) => ({
          text,
          options: { bullet: { indent: 20 }, hanging: 5, breakLine: true },
        })),
        {
          x: 0.65,
          y: 2.4,
          w: 11.8,
          h: 4.25,
          fontSize: 21,
          color: '21382F',
          paraSpaceAfter: 16,
          valign: 'top',
          fit: 'shrink',
          margin: 0.05,
        },
      );
    slide.addText(`${index + 1}`, {
      x: 12,
      y: 7.0,
      w: 0.7,
      h: 0.2,
      fontSize: 10,
      color: '53685F',
      align: 'right',
    });
    slide.addNotes(data.notes || '');
  });
  return Buffer.from(await ppt.write({ outputType: 'nodebuffer', compression: true }));
}
export async function renderArtifact(input) {
  const normalized = normalizeArtifact(input);
  if (normalized.kind === 'web') {
    try {
      artifactHtmlCheck(normalized.source);
    } catch (error) {
      throw new Error(`${error.message} This result was not saved.`);
    }
  }
  const bytes =
    normalized.kind === 'document'
      ? await documentBytes(normalized.source, normalized.title)
      : normalized.kind === 'spreadsheet'
        ? await spreadsheetBytes(normalized.source, normalized.title)
        : normalized.kind === 'presentation'
          ? await presentationBytes(normalized.source, normalized.title)
          : Buffer.from(previewHtml(normalized.source), 'utf8');
  if (bytes.length > 2 * 1024 * 1024)
    throw new Error('The exported result exceeds 2 MB. Split it into smaller results.');
  return { ...normalized, bytes };
}
const digest = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const response = (a, v) => ({
  id: a.id,
  kind: a.kind,
  title: v.title,
  version: v.number,
  fileId: v.fileId,
});
export async function saveArtifact(
  store,
  input,
  { guard, sourceMessageId = '', threadId = '', operationId, requireUniqueTitle = false } = {},
) {
  guard?.();
  const normalized = normalizeArtifact(input);
  const expected = input.expectedVersion ?? 0;
  if (!Number.isInteger(expected) || expected < 0 || (!input.id && expected !== 0))
    throw new Error('Supply the current version before editing a result.');
  const key = operationId || input.operationId;
  if (typeof key !== 'string' || !key || key.length > 200)
    throw new Error('A save operation ID is required.');
  const fingerprint = digest({ ...normalized, id: input.id || '', expected });
  function existing(s) {
    if (s.deletedArtifactOperations?.includes(key))
      throw new Error('This result was removed. Start a new save to create another result.');
    for (const a of s.artifacts || [])
      for (const v of a.versions)
        if (v.operationId === key) {
          if (v.fingerprint !== fingerprint)
            throw new Error('This save ID was already used for different content.');
          return response(a, v);
        }
  }
  function current(s) {
    if (!input.id) {
      if (requireUniqueTitle) {
        const titleKey = (value) => value.normalize('NFKC').trim().toLowerCase();
        const match = s.artifacts?.find(
          (a) =>
            a.kind === normalized.kind &&
            titleKey(a.versions.at(-1).title) === titleKey(normalized.title),
        );
        if (match)
          throw new Error(
            `A ${normalized.kind} with this title already exists. Do not create a disconnected copy. Read it with read_artifact id=${match.id}, then save_artifact with id=${match.id} and expectedVersion=${match.versions.at(-1).number} to revise it. If the owner explicitly wants a separate result, use a distinct title.`,
          );
      }
      return null;
    }
    const { artifact } = artifactVersion(s, input.id);
    if (artifact.kind !== normalized.kind)
      throw new Error(
        'Keep the same result type when saving a new version. To create a separate result in another format, omit id and expectedVersion; the original will remain unchanged.',
      );
    if (artifact.versions.at(-1).number !== expected)
      throw new Error(
        expected < artifact.versions.at(-1).number
          ? `This result has a newer version (${artifact.versions.at(-1).number}). Reopen it before saving your changes.`
          : `The current version is ${artifact.versions.at(-1).number}. expectedVersion must be the version you read, not the next version. Read the result again, then retry with its current version.`,
      );
    if (artifact.versions.length >= 20)
      throw new Error('This result has 20 versions. Create a new result to continue.');
    return artifact;
  }
  const before = store.read();
  const done = existing(before);
  if (done) return done;
  current(before);
  const { bytes } = await renderArtifact(normalized);
  guard?.();
  return store.mutate((s) => {
    guard?.();
    const duplicate = existing(s);
    if (duplicate) return duplicate;
    const artifacts = (s.artifacts ||= []);
    let a = current(s);
    if (!a && artifacts.length >= 50)
      throw new Error('This workspace has reached its limit of 50 generated results.');
    const total =
      Buffer.byteLength(JSON.stringify(artifacts)) +
      s.files.filter((f) => f.artifactId).reduce((n, f) => n + (f.base64?.length || 0), 0);
    if (total + (bytes.length * 4) / 3 + Buffer.byteLength(normalized.source) > 12 * 1024 * 1024)
      throw new Error('Generated results have reached the 12 MB workspace limit.');
    if (!a) {
      a = {
        id: uid('artifact'),
        kind: normalized.kind,
        threadId,
        sourceMessageId,
        createdAt: iso(),
        versions: [],
      };
      artifacts.unshift(a);
    }
    const number = a.versions.length + 1,
      fileId = uid('file'),
      createdAt = iso();
    const name =
      normalized.title.replace(/[\u0000-\u001f/\\:*?"<>|]/g, '_').replace(/^\.+/, '') || 'Result';
    s.files.unshift({
      id: fileId,
      name: `${name}.${artifactKinds[a.kind].extension}`,
      mime: artifactKinds[a.kind].mime,
      size: bytes.length,
      base64: bytes.toString('base64'),
      source: 'Relay',
      createdAt,
      artifactId: a.id,
      artifactVersion: number,
    });
    const version = {
      number,
      title: normalized.title,
      source: normalized.source,
      fileId,
      createdAt,
      operationId: key,
      fingerprint,
      sourceMessageId,
    };
    a.versions.push(version);
    a.updatedAt = createdAt;
    return response(a, version);
  });
}
