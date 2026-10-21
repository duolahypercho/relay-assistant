// SPDX-License-Identifier: MIT
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { readOffice } from './office-files.mjs';
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const escapeXml = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Keep XML markup and all unrelated ZIP entries intact. This deliberately supports
// unique literals within a single existing text node, not layout or rich-text edits.
function textNodes(xml) {
  const parser = new SaxesParser({ xmlns: true });
  const nodes = [],
    stack = [];
  let active,
    supported = false;
  parser.on('doctype', () => {
    throw Error('Document types are not supported.');
  });
  parser.on('opentag', (tag) => {
    if (!stack.length)
      supported =
        tag.uri === word && ['document', 'hdr', 'ftr', 'footnotes', 'endnotes'].includes(tag.local);
    if (active) throw Error('This Word text node has unsupported nested content.');
    if (
      supported &&
      tag.uri === word &&
      tag.local === 't' &&
      !tag.isSelfClosing &&
      !stack.some((t) => t.uri === word && ['del', 'moveFrom'].includes(t.local))
    )
      active = {
        start: parser.position,
        text: '',
        preserveSpace: tag.attributes['xml:space']?.value === 'preserve',
      };
    stack.push(tag);
  });
  parser.on('text', (text) => {
    if (active) active.text += text;
  });
  parser.on('cdata', (text) => {
    if (active) active.text += text;
  });
  parser.on('closetag', () => {
    if (active) {
      nodes.push({ ...active, end: xml.lastIndexOf('<', parser.position - 1) });
      active = null;
    }
    stack.pop();
  });
  parser.write(xml).close();
  return nodes;
}
function xmlPart(bytes) {
  const le = bytes[0] === 255 && bytes[1] === 254;
  const be = bytes[0] === 254 && bytes[1] === 255;
  const bom = !le && !be && bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
  return {
    text: new TextDecoder(le ? 'utf-16le' : be ? 'utf-16be' : 'utf-8', { fatal: true }).decode(
      bytes,
    ),
    encode(text) {
      if (le || be) {
        const b = Buffer.from(text, 'utf16le');
        if (be) b.swap16();
        return Buffer.concat([Buffer.from(be ? [254, 255] : [255, 254]), b]);
      }
      const b = Buffer.from(text);
      return bom ? Buffer.concat([Buffer.from([239, 187, 191]), b]) : b;
    },
  };
}
export async function editComputerDocx(file, { contentHash, edits, signal } = {}) {
  if (!/\.docx$/i.test(file.name || '')) throw Error('Choose a DOCX document.');
  if (!/^[a-f0-9]{64}$/.test(contentHash || ''))
    throw Error('Read the document first and supply its contentHash.');
  if (
    !Array.isArray(edits) ||
    !edits.length ||
    edits.length > 20 ||
    edits.some(
      (e) =>
        typeof e?.find !== 'string' ||
        !e.find ||
        e.find.length > 4000 ||
        typeof e.replace !== 'string' ||
        e.replace.length > 4000 ||
        /[\u0000-\u001f\ufffe\uffff]/u.test(e.find + e.replace) ||
        !e.find.isWellFormed() ||
        !e.replace.isWellFormed(),
    )
  )
    throw Error(
      'Supply 1–20 plain-text find/replace edits of up to 4000 characters each, without control characters.',
    );
  signal?.throwIfAborted();
  await readOffice(file, { contentHash, signal }); // Validate bounded archive, XML, CRCs and source version.
  const zip = await JSZip.loadAsync(Buffer.from(file.base64, 'base64'));
  if (Object.keys(zip.files).some((name) => name.startsWith('_xmlsignatures/')))
    throw Error('This document is signed. Use an unsigned copy for editing.');
  const parts = [];
  for (const entry of Object.values(zip.files)) {
    signal?.throwIfAborted();
    if (!entry.dir && /\.xml$/i.test(entry.name)) {
      const part = xmlPart(await entry.async('nodebuffer'));
      const nodes = textNodes(part.text);
      if (nodes.length) parts.push({ ...part, name: entry.name, nodes });
    }
  }
  for (const { find, replace } of edits) {
    const matches = [];
    for (const part of parts)
      for (const node of part.nodes) {
        for (let at = node.text.indexOf(find); at !== -1; at = node.text.indexOf(find, at + 1))
          matches.push({ node, at });
      }
    if (matches.length !== 1)
      throw Error(
        matches.length
          ? 'This text occurs more than once. Use a unique literal; no file was written.'
          : 'This literal was not found within a single Word text run. It may span runs; use document tools to inspect it. No file was written.',
      );
    const { node, at } = matches[0];
    node.text = node.text.slice(0, at) + replace + node.text.slice(at + find.length);
    if (!node.preserveSpace && node.text.trim() !== node.text)
      throw Error(
        'This replacement needs a whitespace-format change. Use document tools to inspect it; no file was written.',
      );
    node.changed = true;
  }
  for (const part of parts) {
    let xml = part.text;
    for (const node of [...part.nodes].reverse())
      if (node.changed) xml = xml.slice(0, node.start) + escapeXml(node.text) + xml.slice(node.end);
    if (xml !== part.text)
      zip.file(part.name, part.encode(xml), { date: zip.file(part.name).date });
  }
  signal?.throwIfAborted();
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  signal?.throwIfAborted();
  if (bytes.length > 8_000_000)
    throw Error('The edited document exceeds the 8 MB computer-file limit.');
  return { base64: bytes.toString('base64'), changes: edits.length };
}
