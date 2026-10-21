// SPDX-License-Identifier: MIT
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { shapePaths, validateAppearance } from '../shared/appearance.mjs';
import {
  validateTemplate,
  prepareTemplate,
  templateWarnings,
} from '../shared/assistant-templates.mjs';
import { assistantProfile } from '../shared/assistant-scope.mjs';
const digest = (data) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
export function templateReview(template, access) {
  if (!['public', 'workspace'].includes(access))
    throw new Error('Choose public or workspace access.');
  const normalized = validateTemplate(template);
  const warnings = templateWarnings(normalized);
  if (warnings.length)
    throw new Error(`Remove possible credentials or private URLs from: ${warnings.join(', ')}.`);
  return { template: normalized, digest: digest({ access, template: normalized }) };
}
export class AssistantTemplates {
  constructor(store) {
    this.store = store;
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS assistant_templates (token TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, access TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)',
    );
  }
  read(token) {
    if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
    const r = this.store.db.prepare('SELECT * FROM assistant_templates WHERE token=?').get(token);
    return r
      ? {
          token: r.token,
          assistantId: r.assistant_id,
          access: r.access,
          revision: r.revision,
          template: JSON.parse(r.body),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          revoked: !!r.revoked,
        }
      : null;
  }
  list(assistantId) {
    assistantProfile(this.store.read(), assistantId);
    return this.store.db
      .prepare(
        'SELECT token FROM assistant_templates WHERE assistant_id=? ORDER BY created_at DESC',
      )
      .all(assistantId)
      .map((r) => this.read(r.token));
  }
  save(p) {
    assistantProfile(this.store.read(), p.assistantId);
    const review = templateReview(p.template, p.access);
    if (p.reviewedDigest !== review.digest)
      throw new Error('The template or access changed. Review the latest preview before sharing.');
    const previous = p.token ? this.read(p.token) : null;
    if (
      p.token &&
      (!previous ||
        previous.assistantId !== p.assistantId ||
        previous.revoked ||
        previous.revision !== p.revision)
    )
      throw new Error('This link changed or was revoked. Open its latest details.');
    if (!previous && this.list(p.assistantId).filter((x) => !x.revoked).length >= 20)
      throw new Error('Revoke an existing link before creating more than 20 for one assistant.');
    const token = previous?.token || randomBytes(32).toString('base64url'),
      now = new Date().toISOString();
    if (previous)
      this.store.db
        .prepare(
          'UPDATE assistant_templates SET access=?,revision=revision+1,body=?,updated_at=? WHERE token=? AND revision=? AND revoked=0',
        )
        .run(p.access, JSON.stringify(review.template), now, token, p.revision);
    else
      this.store.db
        .prepare('INSERT INTO assistant_templates VALUES (?,?,?,?,?,?,?,0)')
        .run(token, p.assistantId, p.access, 1, JSON.stringify(review.template), now, now);
    return this.read(token);
  }
  revoke(token, revision) {
    const current = this.read(token);
    if (!current || current.revision !== revision)
      throw new Error('This link changed. Refresh its details.');
    if (!current.revoked)
      this.store.db
        .prepare(
          'UPDATE assistant_templates SET revoked=1,revision=revision+1,updated_at=? WHERE token=?',
        )
        .run(new Date().toISOString(), token);
    return this.read(token);
  }
}
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
function previewHtml(record, nonce) {
  const t = record.template,
    p = t.profile;
  const appearance = validateAppearance(p.appearance);
  const avatar =
    appearance.kind === 'shape'
      ? `<svg viewBox="0 0 100 100"><path d="${shapePaths[appearance.shape]}" fill="${p.avatarColor}"/><g fill="#28352d"><ellipse cx="37" cy="48" rx="4.5" ry="6"/><ellipse cx="64" cy="48" rx="4.5" ry="6"/></g><path d="M44 60Q50 66 57 59" fill="none" stroke="#28352d" stroke-width="3" stroke-linecap="round"/></svg>`
      : appearance.kind === 'image'
        ? `<img alt="" src="/api/shared-assistants/${record.token}/avatar">`
        : `<span class="sprout"></span>`;
  const displayed = structuredClone(t);
  if (displayed.profile.appearance?.kind === 'image')
    displayed.profile.appearance.data =
      '[PNG picture shown above; pixel bytes included in download]';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(p.name)} · Relay template</title><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#fffefa;color:#263d33;font:16px/1.6 system-ui}main{max-width:760px;margin:auto;padding:48px 24px}h1{font-size:36px;line-height:1.2;margin:20px 0 12px}h2{font-size:22px;margin:28px 0 12px}.badge{display:grid;place-items:center;width:64px;height:64px;border-radius:23px;background:color-mix(in srgb, ${p.avatarColor} 30%, white);color:#17271f;font-size:28px;border:1px solid #829288}.badge{border:0;background:transparent}.badge img,.badge svg{width:100%;height:100%;border-radius:23px}.badge svg>path:first-child{fill:color-mix(in srgb,${p.avatarColor} 62%,#fff8e9);stroke:color-mix(in srgb,${p.avatarColor} 75%,#526558);stroke-width:1.3}.sprout{width:100%;height:100%;background:url('/api/shared-assistants/${record.token}/avatar') 0 0/400% 400% no-repeat}.muted{color:#536459}p,pre{overflow-wrap:anywhere;white-space:pre-wrap}pre{font:14px/1.6 ui-monospace;max-height:460px;overflow:auto}section{padding:20px;border:1px solid #d9e0d9;border-radius:20px;margin:24px 0}label{display:block;font-weight:600;margin-top:14px}input{display:block;width:100%;padding:12px;border:1px solid #829288;border-radius:12px;font:inherit;margin:6px 0 14px}button,.download{display:inline-block;background:#2b5342;color:#fffefa;padding:12px 18px;border:0;border-radius:12px;font:inherit;text-decoration:none;cursor:pointer}a{color:#2b5342}summary{cursor:pointer;font-weight:600;padding:8px 0}details{border-top:1px solid #d9e0d9;padding-top:8px;margin-top:12px}footer{margin-top:36px;font-size:14px}#error{color:#9c2926}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #366b9c;outline-offset:3px}</style></head><body><main><a href="/">Relay</a><p class="muted">Shared assistant template · version ${record.revision}</p><div class="badge" aria-hidden="true">${avatar}</div><h1>${escape(p.name)}</h1><p>${escape(p.description || 'A reusable assistant setup.')}</p><p class="muted">${t.skills.length} ${t.skills.length === 1 ? 'skill' : 'skills'} · ${t.routines.length} ${t.routines.length === 1 ? 'routine' : 'routines'} · ${escape(p.tone)}</p><section><h2>Make it yours</h2><p>Add a new assistant to your workspace. You get its setup, with empty chats and memories. Routines start paused. This link gives no access to the creator’s computer, files or accounts.</p><a id="open-app" class="download">Open in Relay</a><p class="muted">Review this setup in your connected app. Nothing is added until you choose Add assistant.</p><details><summary>Use a browser instead</summary><form id="add"><label for="destination">Your Relay server</label><input id="destination" type="url" required placeholder="https://relay.example.com"><button type="submit">Review in my Relay</button><p id="error" role="alert"></p></form></details><a class="download" href="/api/shared-assistants/${record.token}/download">Download template</a></section><h2>What this template includes</h2>${t.skills.map((s) => `<details><summary>Skill: ${escape(s.title)}</summary><p>${escape(s.description)}</p><p>${escape(s.instructions)}</p></details>`).join('')}${t.routines.map((r) => `<details><summary>Routine: ${escape(r.title)}</summary><p>${escape(r.instructions)}</p><pre>${escape(JSON.stringify(r.schedule, null, 2))}</pre>${r.skill ? `<p>${escape(r.skill.instructions)}</p>` : ''}</details>`).join('')}<details><summary>Full configuration</summary><pre>${escape(JSON.stringify(displayed, null, 2))}</pre></details><footer class="muted">Created by a Relay user. Review instructions and schedules before adding it. Links can be updated or revoked; downloaded and imported copies remain with their recipients.</footer></main><script nonce="${nonce}">document.getElementById('open-app').href='relay-assistant://template?url='+encodeURIComponent(location.origin+location.pathname);document.getElementById('destination').value=location.origin;document.getElementById('add').addEventListener('submit',event=>{event.preventDefault();try{const target=new URL(document.getElementById('destination').value);if(target.username||target.password||target.search||target.hash||target.pathname!=='/'||!(target.protocol==='https:'||target.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(target.hostname)))throw Error();target.hash='assistants?import='+encodeURIComponent(location.origin+location.pathname);location.assign(target.href)}catch{document.getElementById('error').textContent='Use your Relay HTTPS origin, or a loopback development server, without a path or sign-in details.'}});</script></body></html>`;
}
export function publicTemplateRoutes(app, manager, authenticated) {
  const access = (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Frame-Options': 'DENY',
    });
    const record = manager.read(req.params.token);
    if (!record || record.revoked || (record.access !== 'public' && !authenticated(req)))
      return res
        .status(404)
        .json({ error: 'This template is unavailable or requires workspace sign-in.' });
    res.locals.template = record;
    if (record.access === 'public') res.set('Access-Control-Allow-Origin', '*');
    next();
  };
  app.get('/api/shared-assistants/:token', access, (_req, res) =>
    res.json({ template: res.locals.template.template, revision: res.locals.template.revision }),
  );
  app.get('/api/shared-assistants/:token/avatar', access, async (_req, res, next) => {
    try {
      const appearance = validateAppearance(res.locals.template.template.profile.appearance);
      if (appearance.kind === 'shape') return res.status(404).end();
      const bytes =
        appearance.kind === 'image'
          ? Buffer.from(appearance.data.slice(22), 'base64')
          : await readFile(new URL('../src/assets/relay-sprout-anime.png', import.meta.url));
      res.set('X-Content-Type-Options', 'nosniff').type('image/png').send(bytes);
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/shared-assistants/:token/download', access, (_req, res) => {
    res.set('Content-Disposition', 'attachment; filename="relay-assistant.json"');
    res.type('application/json').send(JSON.stringify(res.locals.template.template, null, 2) + '\n');
  });
  app.get('/share/assistant/:token', access, (_req, res) => {
    const nonce = randomBytes(18).toString('base64');
    res.set(
      'Content-Security-Policy',
      `default-src 'none'; img-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    res.type('html').send(previewHtml(res.locals.template, nonce));
  });
}
export function ownerTemplateRoutes(app, manager, config) {
  const base = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;
  const output = (req, row) => ({ ...row, url: `${base(req)}/share/assistant/${row.token}` });
  app.get('/api/assistant-templates', (req, res, next) => {
    try {
      res.json({
        links: manager.list(String(req.query.assistantId)).map((r) => output(req, r)),
        workspaceAccessAvailable: !!config.accessKey,
      });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/assistant-templates/prepare', (req, res, next) => {
    try {
      res.json(prepareTemplate(manager.store.read(), req.body.assistantId));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/assistant-templates/review', (req, res, next) => {
    try {
      res.json(templateReview(req.body.template, req.body.access));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/assistant-templates', (req, res, next) => {
    try {
      if (req.body.access === 'workspace' && !config.accessKey)
        throw new Error('Configure a server access key before making workspace-only links.');
      res.json({ link: output(req, manager.save(req.body)) });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/assistant-templates/:token/revoke', (req, res, next) => {
    try {
      res.json({ link: output(req, manager.revoke(req.params.token, req.body.revision)) });
    } catch (e) {
      next(e);
    }
  });
}
