// SPDX-License-Identifier: MIT
export const artifactKinds = {
  document: {
    label: 'Document',
    extension: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  spreadsheet: {
    label: 'Spreadsheet',
    extension: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  presentation: {
    label: 'Slide deck',
    extension: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  web: { label: 'Interactive page', extension: 'html', mime: 'text/html' },
};
const fail = (message) => {
  throw new Error(message);
};
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, label, max, empty = false) => {
  if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max)
    fail(`${label} must be ${empty ? '0' : '1'}–${max} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))
    fail(`${label} contains unsupported control characters.`);
  return v;
};
export function normalizeArtifact(input) {
  if (!object(input) || !Object.hasOwn(artifactKinds, input.kind))
    fail('Choose a document, spreadsheet, slide deck, or interactive page.');
  const title = text(input.title, 'Title', 120).trim();
  const source = text(input.source, 'Content', 200000);
  if (input.kind === 'document' || input.kind === 'web') return { kind: input.kind, title, source };
  let data;
  try {
    data = JSON.parse(source);
  } catch {
    fail('Content must be valid JSON.');
  }
  if (!object(data)) fail('Content must be an object.');
  if (input.kind === 'spreadsheet') {
    if (!Array.isArray(data.sheets) || !data.sheets.length || data.sheets.length > 10)
      fail('Use 1–10 sheets.');
    let cells = 0;
    const names = new Set();
    data = {
      sheets: data.sheets.map((sheet) => {
        if (!object(sheet)) fail('Each sheet needs a name and rows.');
        const name = text(sheet.name, 'Sheet name', 31).trim();
        if (/[\\/*?:\[\]]/.test(name) || /^'|'$/.test(name) || names.has(name.toLowerCase()))
          fail('Use unique sheet names without / \\ * ? : [ ] or surrounding apostrophes.');
        names.add(name.toLowerCase());
        if (!Array.isArray(sheet.rows) || !sheet.rows.length || sheet.rows.length > 200)
          fail('Use 1–200 rows per sheet.');
        const rows = sheet.rows.map((row) => {
          if (!Array.isArray(row))
            fail('Every row must be an array of cells, e.g. ["Train",25], not an object.');
          if (row.length > 50) fail('Use at most 50 columns per row.');
          cells += row.length;
          if (cells > 10000) fail('Use at most 10,000 cells.');
          return row.map((cell) => {
            if (
              cell === null ||
              typeof cell === 'boolean' ||
              (typeof cell === 'number' && Number.isFinite(cell))
            )
              return cell;
            if (typeof cell === 'string') return text(cell, 'Cell text', 2000, true);
            if (object(cell) && Object.keys(cell).length === 1 && typeof cell.formula === 'string')
              return { formula: text(cell.formula, 'Formula', 300).replace(/^=/, '') };
            fail('Cells can contain text, numbers, booleans, null, or {"formula":"SUM(B2:B4)"}.');
          });
        });
        calculateSheet(rows); // Reject unsupported formulas, errors and cycles before saving.
        return { name, rows };
      }),
    };
  } else {
    if (!Array.isArray(data.slides) || !data.slides.length || data.slides.length > 30)
      fail('Use 1–30 slides.');
    data = {
      slides: data.slides.map((slide) => {
        if (!object(slide) || !Array.isArray(slide.bullets) || slide.bullets.length > 6)
          fail('Each slide needs a title and up to six bullet points.');
        return {
          title: text(slide.title, 'Slide title', 90),
          bullets: slide.bullets.map((b) => text(b, 'Bullet point', 180)),
          notes: text(slide.notes ?? '', 'Speaker notes', 4000, true),
        };
      }),
    };
  }
  return { kind: input.kind, title, source: JSON.stringify(data, null, 2) };
}
export function columnName(index) {
  let result = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}
// Bounded arithmetic evaluator, never eval/Function or an Office formula engine.
// Only numeric same-sheet references and these six aggregate functions are accepted.
export function calculateSheet(rows) {
  const cache = new Map(),
    visiting = new Set();
  let work = 0;
  const number = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v))
      fail('Formulas must produce finite numbers. Check cell types and division by zero.');
    return v;
  };
  const address = (ref) => {
    const m = /^\$?([A-Z]{1,2})\$?([1-9][0-9]{0,2})$/i.exec(ref);
    if (!m) fail(`Unsupported cell reference: ${ref}.`);
    const col = [...m[1].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const row = Number(m[2]) - 1;
    if (col >= 50 || row >= 200) fail('Formula references must stay within AX200.');
    return [row, col];
  };
  function cell(r, c, depth = 0) {
    if (++work > 100000 || depth > 100) fail('The formulas are too complex.');
    const key = `${r}:${c}`;
    if (cache.has(key)) return cache.get(key);
    if (visiting.has(key)) fail('A formula contains a circular reference.');
    const value = rows[r]?.[c] ?? null;
    if (!object(value)) return value;
    visiting.add(key);
    const v = formula(value.formula, depth + 1);
    visiting.delete(key);
    cache.set(key, v);
    return v;
  }
  function formula(source, depth) {
    const tokens =
      source.match(
        /\$?[A-Z]{1,2}\$?[1-9][0-9]*|[A-Z]+|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)|[()+\-*/^,:]/gi,
      ) || [];
    if (
      tokens.join('').toUpperCase() !== source.replace(/\s/g, '').toUpperCase() ||
      tokens.length > 200
    )
      fail('Use cell references, arithmetic, SUM, AVERAGE, MIN, MAX, COUNT, or ROUND.');
    let i = 0,
      nesting = 0;
    const take = (t) => {
      if (tokens[i] === t) {
        i++;
        return true;
      }
      return false;
    };
    const expect = (t) => {
      if (!take(t)) fail(`Expected ${t} in formula.`);
    };
    const ref = (t) => /^\$?[A-Z]{1,2}\$?[1-9][0-9]*$/i.test(t || '');
    function primary() {
      if (++nesting > 80) fail('The formula is too deeply nested.');
      let v;
      const t = tokens[i++];
      if (t === '(') {
        v = expression();
        expect(')');
      } else if (ref(t)) {
        const [r, c] = address(t);
        v = cell(r, c, depth);
        if (v === null) v = 0;
      } else if (/^[A-Z]+$/i.test(t || '')) {
        const name = t.toUpperCase();
        if (!['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'ROUND'].includes(name))
          fail(`Unsupported formula function: ${name}.`);
        expect('(');
        const args = [];
        if (!take(')')) {
          do {
            if (ref(tokens[i]) && tokens[i + 1] === ':') {
              const [r1, c1] = address(tokens[i]);
              i += 2;
              const [r2, c2] = address(tokens[i++]);
              if (r2 < r1 || c2 < c1) fail('Use a forward cell range.');
              for (let r = r1; r <= r2; r++)
                for (let c = c1; c <= c2; c++) {
                  const value = cell(r, c, depth);
                  if (typeof value === 'number') args.push(value);
                }
            } else args.push(expression());
          } while (take(','));
          expect(')');
        }
        if (name === 'ROUND') {
          if (args.length !== 2 || !Number.isInteger(args[1]) || Math.abs(args[1]) > 12)
            fail('ROUND needs a number and integer precision from -12 to 12.');
          const factor = 10 ** args[1];
          v = (Math.sign(args[0]) * Math.round(Math.abs(args[0]) * factor)) / factor;
        } else if (name === 'COUNT') v = args.length;
        else if (name === 'SUM') v = args.reduce((a, b) => a + b, 0);
        else {
          if (!args.length) fail(`${name} needs numeric cells.`);
          v =
            name === 'AVERAGE'
              ? args.reduce((a, b) => a + b, 0) / args.length
              : name === 'MIN'
                ? Math.min(...args)
                : Math.max(...args);
        }
      } else if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(t || '')) v = Number(t);
      else fail('The formula is incomplete.');
      nesting--;
      return number(v);
    }
    // Excel-style unary precedence, with exponentiation evaluated left-to-right.
    function unary() {
      if (take('+')) return primary();
      if (take('-')) return -primary();
      return primary();
    }
    function power() {
      let v = unary();
      while (take('^')) v = number(v ** unary());
      return v;
    }
    function product() {
      let v = power();
      while (tokens[i] === '*' || tokens[i] === '/') {
        const op = tokens[i++],
          rhs = power();
        v = number(op === '*' ? v * rhs : v / rhs);
      }
      return v;
    }
    function expression() {
      let v = product();
      while (tokens[i] === '+' || tokens[i] === '-') {
        const op = tokens[i++],
          rhs = product();
        v = number(op === '+' ? v + rhs : v - rhs);
      }
      return v;
    }
    const v = expression();
    if (i !== tokens.length) fail('Unexpected content in formula.');
    return number(v);
  }
  return rows.map((row, r) => row.map((_, c) => cell(r, c)));
}
export const previewPolicy =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function previewHtml(source) {
  // The CSP comes before any generated markup; subsequent meta tags cannot relax it.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${previewPolicy}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Relay preview</title></head><body>${source}</body></html>`;
}
export function artifactVersion(s, id, number) {
  const artifact = (s.artifacts || []).find((a) => a.id === id);
  if (!artifact) fail('This result could not be found.');
  const version =
    number == null
      ? artifact.versions.at(-1)
      : artifact.versions.find((v) => v.number === Number(number));
  if (!version) fail('This version could not be found.');
  return { artifact, version };
}
