// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { safeFetch } from './network.mjs';
import { readSkillDocument, SKILL_DOCUMENT_LIMIT } from '../shared/skill-document.mjs';
import {
  skillFiles,
  skillPath,
  SKILL_FILE_LIMIT,
  SKILL_FILES_LIMIT,
} from '../shared/skill-package.mjs';

const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const error = (message) => Object.assign(new Error(message), { status: 400 });
const linkError = () => error('Paste a public GitHub skill folder or SKILL.md link.');
const encode = (parts) => parts.map(encodeURIComponent).join('/');

export function githubSkillLink(value) {
  if (typeof value !== 'string' || value.length > 2000) throw linkError();
  let url, parts;
  try {
    url = new URL(value.trim());
    parts = url.pathname.replace(/\/$/, '').split('/').slice(1).map(decodeURIComponent);
  } catch {
    throw linkError();
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.some(
      (part) => !part || /[\\/\u0000-\u001f\u007f]/.test(part) || part === '.' || part === '..',
    )
  )
    throw linkError();
  const [owner, repository, kind, ...tail] = parts;
  if (
    !/^[A-Za-z0-9-]{1,39}$/.test(owner || '') ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(repository || '') ||
    repository === '.' ||
    repository === '..' ||
    parts.length > 20
  )
    throw linkError();
  if (parts.length !== 2 && (!['tree', 'blob'].includes(kind) || !tail.length)) throw linkError();
  if (kind === 'blob' && (tail.length < 2 || tail.at(-1) !== 'SKILL.md')) throw linkError();
  return { owner, repository, kind, tail };
}

/** Public, read-only import. No account token, git process, extraction or execution. */
export class SkillRepository {
  constructor({ fetch = safeFetch, timeout = 75000 } = {}) {
    this.fetch = fetch;
    this.timeout = timeout;
    this.active = 0;
  }
  async read(value, { signal } = {}) {
    const link = githubSkillLink(value);
    if (this.active >= 2)
      throw Object.assign(
        error('Two skills are already loading. Wait or cancel one, then try again.'),
        { status: 429 },
      );
    this.active++;
    const deadline = AbortSignal.timeout(this.timeout);
    const current = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const root = `/repos/${encode([link.owner, link.repository])}`;
    let calls = 0;
    const get = async (path, { raw = false, limit = 1024 * 1024 } = {}) => {
      current.throwIfAborted();
      if (++calls > 85)
        throw error('This skill needs too many downloads. Import a skill ZIP instead.');
      const url = (raw ? 'https://raw.githubusercontent.com' : 'https://api.github.com') + path;
      let response, cancel;
      const interrupted = new Promise((_, reject) => {
        cancel = () => reject(current.reason);
        current.addEventListener('abort', cancel, { once: true });
        if (current.aborted) cancel();
      });
      try {
        response = await Promise.race([
          this.fetch(url, {
            signal: current,
            redirects: 0,
            maxBytes: limit,
            headers: {
              Accept: raw ? 'application/octet-stream' : 'application/vnd.github+json',
              'User-Agent': 'RelayAssistant/0.1 (skill-import)',
              ...(!raw ? { 'X-GitHub-Api-Version': '2026-03-10' } : {}),
            },
          }),
          interrupted,
        ]);
      } catch (cause) {
        current.throwIfAborted();
        if (/HTTP (403|429)/.test(cause.message))
          throw error('GitHub is limiting downloads. Try later or import a skill ZIP.');
        if (/HTTP 404/.test(cause.message))
          throw error(
            'That public skill could not be found. Check the link, or import a skill ZIP.',
          );
        throw error(
          'The skill could not be downloaded within its limits. Check the link or import a skill ZIP.',
        );
      } finally {
        current.removeEventListener('abort', cancel);
      }
      current.throwIfAborted();
      if (
        !Buffer.isBuffer(response.bytes) ||
        response.bytes.length > limit ||
        response.status !== 200 ||
        response.url !== url
      )
        throw error('GitHub returned an unexpected download. Use a direct public skill link.');
      if (raw) return response.bytes;
      try {
        return JSON.parse(response.bytes.toString('utf8'));
      } catch {
        throw error('GitHub returned an unreadable response. Try again later.');
      }
    };
    try {
      let commit,
        folder = [];
      if (!link.kind) {
        const repository = await get(root);
        if (typeof repository.default_branch !== 'string' || repository.default_branch.length > 240)
          throw linkError();
        const ref = await get(
          `${root}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`,
        );
        if (ref.object?.type !== 'commit' || !sha(ref.object.sha))
          throw error('This repository has no usable default branch.');
        commit = ref.object.sha;
      } else if (sha(link.tail[0])) {
        commit = link.tail[0];
        folder = link.tail.slice(1);
      } else {
        // GitHub links can contain slash-named branches. Resolve the longest actual
        // branch/tag prefix before interpreting any of the remaining path as a folder.
        const candidates = [];
        for (const type of ['heads', 'tags']) {
          const refs = await get(
            `${root}/git/matching-refs/${type}/${encodeURIComponent(link.tail[0])}`,
            { limit: 512 * 1024 },
          );
          if (!Array.isArray(refs) || refs.length > 512)
            throw error('This reference is ambiguous. Use GitHub’s Copy permalink link.');
          for (const ref of refs) {
            if (typeof ref.ref !== 'string' || !ref.ref.startsWith(`refs/${type}/`)) continue;
            const name = ref.ref.slice(`refs/${type}/`.length),
              path = link.tail.join('/');
            if (
              name &&
              (path === name || path.startsWith(name + '/')) &&
              sha(ref.object?.sha) &&
              ['commit', 'tag'].includes(ref.object.type)
            )
              candidates.push({ name, sha: ref.object.sha, type: ref.object.type });
          }
        }
        candidates.sort((a, b) => b.name.length - a.name.length);
        const selected = candidates[0];
        if (!selected)
          throw error('That branch or tag could not be found. Use GitHub’s Copy permalink link.');
        if (candidates.some((c) => c.name === selected.name && c.sha !== selected.sha))
          throw error(
            'That branch and tag have different versions. Use GitHub’s Copy permalink link.',
          );
        let object = selected;
        for (let depth = 0; object.type === 'tag' && depth < 4; depth++) {
          const tag = await get(`${root}/git/tags/${object.sha}`);
          if (tag.sha !== object.sha || !sha(tag.object?.sha))
            throw error('The tag version could not be verified.');
          object = tag.object;
        }
        if (object.type !== 'commit' || !sha(object.sha))
          throw error('Choose a skill at a commit, branch or ordinary release tag.');
        commit = object.sha;
        folder = link.tail.slice(selected.name.split('/').length);
      }
      if (link.kind === 'blob') {
        if (folder.at(-1) !== 'SKILL.md') throw linkError();
        folder.pop();
      }
      if (folder.length) skillPath(folder.join('/'));
      const revision = await get(`${root}/git/commits/${commit}`);
      if (revision.sha !== commit || !sha(revision.tree?.sha))
        throw error('The skill version could not be verified.');
      let tree = revision.tree.sha;
      for (const part of folder) {
        const parent = await get(`${root}/git/trees/${tree}`, { limit: 2 * 1024 * 1024 });
        if (parent.sha !== tree || parent.truncated !== false || !Array.isArray(parent.tree))
          throw error('This repository listing is incomplete. Import a skill ZIP instead.');
        const entries = parent.tree.filter((entry) => entry.path === part);
        if (
          entries.length !== 1 ||
          entries[0].type !== 'tree' ||
          entries[0].mode !== '040000' ||
          !sha(entries[0].sha)
        )
          throw error('Choose the folder containing the skill’s SKILL.md file.');
        tree = entries[0].sha;
      }
      const listing = await get(`${root}/git/trees/${tree}?recursive=1`, { limit: 256 * 1024 });
      if (
        listing.sha !== tree ||
        listing.truncated !== false ||
        !Array.isArray(listing.tree) ||
        listing.tree.length > 130
      )
        throw error('This skill folder is too large or incomplete. Choose one skill folder.');
      const paths = new Set(),
        entries = [];
      let total = 0;
      for (const entry of listing.tree) {
        const path = skillPath(entry.path),
          key = path.toLowerCase();
        if (paths.has(key)) throw error('This skill folder has duplicate paths.');
        paths.add(key);
        if (entry.type === 'tree' && entry.mode === '040000') continue;
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !sha(entry.sha))
          throw error('Skill imports support ordinary files only, without links or submodules.');
        if (
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          entry.size > (path === 'SKILL.md' ? SKILL_DOCUMENT_LIMIT : SKILL_FILE_LIMIT)
        )
          throw error('A skill file exceeds its size limit.');
        if (path !== 'SKILL.md') total += entry.size;
        entries.push(entry);
      }
      if (entries.length > 65 || total > SKILL_FILES_LIMIT)
        throw error('A skill can include up to 64 supporting files, under 1 MB in total.');
      if (
        entries.filter((entry) => /(^|\/)SKILL\.md$/i.test(entry.path)).length !== 1 ||
        !entries.some((entry) => entry.path === 'SKILL.md')
      )
        throw error('Choose one skill folder with SKILL.md at its root.');
      const contents = [];
      // Sequential reads make cancellation prompt and bound memory/network concurrency.
      for (const entry of entries) {
        const bytes = await get(
          '/' + encode([link.owner, link.repository, commit, ...folder, ...entry.path.split('/')]),
          { raw: true, limit: entry.size + 1 },
        );
        const digest = createHash('sha1')
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest('hex');
        if (bytes.length !== entry.size || digest !== entry.sha)
          throw error(
            'A downloaded file did not match the reviewed repository version. Try again.',
          );
        contents.push({ path: entry.path, bytes });
      }
      const document = new TextDecoder('utf-8', { fatal: true }).decode(
        contents.find((entry) => entry.path === 'SKILL.md').bytes,
      );
      const method = readSkillDocument(document);
      if (folder.length && folder.at(-1) !== method.slug)
        throw error('The skill folder name must match the name in SKILL.md.');
      const files = skillFiles(
        contents
          .filter((entry) => entry.path !== 'SKILL.md')
          .map((entry) => ({ path: entry.path, base64: entry.bytes.toString('base64') })),
      );
      return {
        document,
        files,
        source: {
          repository: `${link.owner}/${link.repository}`,
          commit,
          url: `https://github.com/${encode([link.owner, link.repository])}/tree/${commit}${folder.length ? '/' + encode(folder) : ''}`,
        },
      };
    } catch (cause) {
      if (current.aborted)
        throw error(
          signal?.aborted
            ? 'Skill download cancelled.'
            : 'This download took too long. Try again or import a skill ZIP.',
        );
      throw cause;
    } finally {
      this.active--;
    }
  }
}

export function skillRepositoryRoutes(app, repository) {
  app.post('/api/skills/repository', async (req, res, next) => {
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.once('close', cancel);
    try {
      res.json(await repository.read(req.body?.url, { signal: controller.signal }));
    } catch (cause) {
      if (!controller.signal.aborted) next(cause);
    } finally {
      res.off('close', cancel);
    }
  });
}
