import { computerBackupRoutes } from './computer-backups.mjs';
import { DeviceLinks, publicDeviceLinkRoutes, ownerDeviceLinkRoutes } from './device-links.mjs';
import { readSkillPackage } from './skill-package.mjs';
import { SkillRepository, skillRepositoryRoutes } from './skill-repository.mjs';
import { readEmail, importEmailAttachment } from './email-files.mjs';
import { readOffice } from './office-files.mjs';
import { notificationRoutes } from './notifications.mjs';
import { assertGroupComputerIdle } from './groups.mjs';
import {
  AssistantTemplates,
  publicTemplateRoutes,
  ownerTemplateRoutes,
} from './assistant-templates.mjs';
// SPDX-License-Identifier: MIT
import express from 'express';
import { once } from 'node:events';
import { connectorRoutes } from './connectors.mjs';
import { publicModelOAuthRoutes, ownerModelOAuthRoutes } from './model-oauth.mjs';
import { trustedBrowserRoutes } from './trusted-browser-routes.mjs';
import {
  publicConnectorOAuthRoutes,
  ownerConnectorOAuthRoutes,
} from './connector-oauth-routes.mjs';
import { ensureTeaching } from './teaching.mjs';
import { ensureVoiceCalls } from './voice-calls.mjs';
import { IdeasService } from './ideas.mjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { command } from '../shared/domain.mjs';
import { fileBytes } from '../shared/pdf.mjs';
import { saveArtifact } from './artifacts.mjs';
import { retryReply } from './chat-retry.mjs';
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((p) => p.trim().split('=')));
}
const digest = (s) => createHash('sha256').update(s).digest('hex');
export function createApp(store, services, config) {
  const app = express();
  ensureTeaching(store, services);
  const voiceCalls = ensureVoiceCalls(store, services);
  if (services.provider)
    services.ideas ||= new IdeasService(store, services.provider, {
      canRun: () => !(services.computer?.enabled && services.computer.controller === 'owner'),
    });
  app.disable('x-powered-by');
  const failures = new Map();
  const streams = new Set();
  const deviceLinks = new DeviceLinks(store, config);
  const deviceLinkOptions = {
    cookie: (req) => cookies(req).relay_session || '',
    changed: () => {
      for (const check of streams) check();
    },
  };
  const origin = config.publicUrl || `http://${config.host}:${config.port}`;
  const allowedHosts = new Set(['127.0.0.1', 'localhost', new URL(origin).hostname]);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-src 'self'; object-src 'none'; base-uri 'self'",
    });
    if (!allowedHosts.has(req.hostname))
      return res.status(403).json({ error: 'This host is not allowed.' });
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== `${req.protocol}://${req.get('host')}` &&
      req.headers.origin !== origin
    )
      return res.status(403).json({ error: 'Cross-origin writes are blocked.' });
    next();
  });
  app.use(express.json({ limit: '12mb', strict: true }));
  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, name: 'Relay', version: '0.1.0', mode: services.mode }),
  );
  app.post('/api/login', (req, res) => {
    if (!config.accessKey) return res.json({ ok: true });
    const ip = req.ip;
    const f = failures.get(ip);
    if (f && f.count >= 8 && f.until > Date.now())
      return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    const value = String(req.body.key || '');
    const expected = Buffer.from(digest(config.accessKey));
    const actual = Buffer.from(digest(value));
    if (!timingSafeEqual(expected, actual)) {
      failures.set(ip, {
        count: (f && f.until > Date.now() ? f.count : 0) + 1,
        until: Date.now() + 60000,
      });
      return res.status(401).json({ error: 'Invalid access key.' });
    }
    failures.delete(ip);
    const token = randomBytes(32).toString('base64url');
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    store.db
      .prepare('INSERT INTO sessions VALUES (?,?)')
      .run(digest(token), Date.now() + 7 * 86400000);
    res.cookie('relay_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: origin.startsWith('https:'),
      maxAge: 7 * 86400000,
    });
    res.json({ ok: true });
  });
  app.get('/api/google/callback', async (req, res, next) => {
    try {
      if (!req.query.state || cookies(req).relay_oauth !== req.query.state)
        throw new Error('The Google callback did not match this connection request.');
      await services.google.callback(String(req.query.code || ''), String(req.query.state));
      res.clearCookie('relay_oauth');
      res.redirect('/?connected=google');
    } catch (e) {
      next(e);
    }
  });
  publicDeviceLinkRoutes(app, deviceLinks, deviceLinkOptions);
  publicConnectorOAuthRoutes(app, services.connectors, config);
  publicModelOAuthRoutes(app, services.provider, config);
  const authenticated = (req) => {
    if (!config.accessKey) return true;
    const token = cookies(req).relay_session || '';
    const session = store.db
      .prepare('SELECT expires FROM sessions WHERE digest=?')
      .get(digest(token));
    return !!session && session.expires >= Date.now();
  };
  const templates = new AssistantTemplates(store);
  publicTemplateRoutes(app, templates, authenticated);
  app.use('/api', (req, res, next) => {
    if (!config.accessKey) return next();
    const token = cookies(req).relay_session || '';
    const session = store.db
      .prepare('SELECT expires FROM sessions WHERE digest=?')
      .get(digest(token));
    if (!session || session.expires < Date.now())
      return res.status(401).json({ error: 'Sign in with your server access key.' });
    next();
  });
  ownerDeviceLinkRoutes(app, deviceLinks, deviceLinkOptions);
  ownerTemplateRoutes(app, templates, config);
  connectorRoutes(app, services.connectors, () => services.provider.configured);
  ownerConnectorOAuthRoutes(app, services.connectors, config);
  ownerModelOAuthRoutes(app, services.provider, config);
  notificationRoutes(app, services.notifications);
  trustedBrowserRoutes(app, services.privateBrowser);
  skillRepositoryRoutes(app, services.skillRepository || new SkillRepository());
  app.post('/api/skills/package', async (req, res, next) => {
    try {
      const data = req.body?.base64;
      if (typeof data !== 'string' || data.length > 2800000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
        throw Error('Choose a skill ZIP of up to 2 MB.');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.toString('base64') !== data) throw Error('Invalid ZIP data.');
      res.json(await readSkillPackage(bytes));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/logout', (req, res) => {
    const t = cookies(req).relay_session;
    store.db.prepare('DELETE FROM sessions WHERE digest=?').run(digest(t || ''));
    for (const check of streams) check();
    res.clearCookie('relay_session');
    res.json({ ok: true });
  });
  const snapshot = () => {
    const s = store.read();
    s.connections.runtime = {
      mode: services.mode,
      storage: 'SQLite',
      browser: services.browser.enabled,
      terminal: services.terminal.enabled,
      desktop: !!services.computer?.enabled,
      privateBrowser: !!services.privateBrowser?.enabled,
      assistantPaused: !!services.computer?.enabled && services.computer.controller === 'owner',
      googleConfigured: services.google.configured,
      model: services.provider.model || '',
      protocol: services.provider.protocol,
      transcription: {
        configured: !!services.transcription?.configured,
        destination: services.transcription?.destination || '',
        inputFormat: services.transcription?.inputFormat || '',
      },
      speech: {
        configured: !!services.speech?.configured,
        destination: services.speech?.destination || '',
      },
    };
    s.connections.model = { configured: services.provider.configured };
    s.connections.apps = services.connectors?.chatCatalog() || [];
    return s;
  };
  app.get('/api/state', (_req, res) => res.json(snapshot()));
  app.post('/api/ideas/refresh', (_req, res, next) => {
    try {
      if (!services.ideas)
        return res
          .status(503)
          .json({ error: 'Personal suggestions are unavailable on this server.' });
      res.json({ result: services.ideas.request() });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/artifacts', async (req, res, next) => {
    try {
      const result = await saveArtifact(store, req.body);
      res.json({ result });
    } catch (error) {
      next(error);
    }
  });
  // Model credentials never enter workspace snapshots, exports, chat messages, or SSE events.
  const models = (req, res, next) => {
    if (!services.provider.publicState)
      return res.status(503).json({ error: 'Model connections are not available on this server.' });
    next();
  };
  app.get('/api/models', models, (_req, res) => res.json(services.provider.publicState()));
  app.get('/api/usage', (req, res, next) => {
    try {
      if (!services.provider.usage)
        return res
          .status(503)
          .json({ error: 'Usage history is unavailable. Update your Relay server.' });
      res
        .set('Cache-Control', 'no-store')
        .json(services.provider.usage.summary(req.query.period || '7d'));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/models/save', models, (req, res, next) => {
    try {
      res.json(services.provider.save(req.body));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/models/select', models, (req, res, next) => {
    try {
      res.json(services.provider.select(req.body.id));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/models/fallbacks', models, (req, res, next) => {
    try {
      res.json(services.provider.setFallbacks(req.body.id, req.body.ids));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/models/remove', models, (req, res, next) => {
    try {
      res.json(services.provider.remove(req.body.id));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/models/discover', models, async (req, res, next) => {
    try {
      res.json(await services.provider.discover(req.body));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/models/local', models, async (_req, res, next) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const [result, runtime] = await Promise.all([
        services.provider.discoverLocal(controller.signal),
        services.localModelRuntime?.status(controller.signal),
      ]);
      if (runtime) result.runtime = runtime;
      if (services.localModelDownloads) result.downloads = services.localModelDownloads.status();
      if (services.localModelInstallation)
        result.installation = services.localModelInstallation.status();
      if (services.localModelSetup) result.setup = services.localModelSetup.status();
      if (!res.destroyed) res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      if (!res.destroyed) next(error);
    }
  });
  app.get('/api/models/local/setup', models, (_req, res, next) => {
    try {
      if (!services.localModelSetup)
        return res.status(503).json({ error: 'Local AI setup is not available on this server.' });
      res.set('Cache-Control', 'no-store').json(services.localModelSetup.status());
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/models/local/setup/:action', models, async (req, res, next) => {
    try {
      const manager = services.localModelSetup;
      if (!manager)
        return res.status(503).json({ error: 'Local AI setup is not available on this server.' });
      const result =
        req.params.action === 'start'
          ? manager.start(req.body)
          : req.params.action === 'cancel'
            ? await manager.cancel(req.body)
            : null;
      if (!result) return res.status(400).json({ error: 'Choose a supported setup action.' });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/models/local/installation', models, (_req, res, next) => {
    try {
      if (!services.localModelInstallation)
        return res
          .status(503)
          .json({ error: 'Local installation is not available on this server.' });
      res.set('Cache-Control', 'no-store').json(services.localModelInstallation.status());
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/models/local/installation/:action', models, async (req, res, next) => {
    try {
      services.localModelSetup?.assertIdle();
      const manager = services.localModelInstallation;
      if (!manager)
        return res
          .status(503)
          .json({ error: 'Local installation is not available on this server.' });
      const result =
        req.params.action === 'start'
          ? manager.start(req.body)
          : req.params.action === 'cancel'
            ? await manager.cancel(req.body)
            : null;
      if (!result)
        return res.status(400).json({ error: 'Choose a supported installation action.' });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/models/local/runtime', models, async (_req, res, next) => {
    try {
      if (!services.localModelRuntime)
        return res.status(503).json({ error: 'Local startup is not available on this server.' });
      res.set('Cache-Control', 'no-store').json(await services.localModelRuntime.status());
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/models/local/download', models, (_req, res, next) => {
    try {
      if (!services.localModelDownloads)
        return res.status(503).json({ error: 'Model downloads are not available on this server.' });
      res.set('Cache-Control', 'no-store').json(services.localModelDownloads.status());
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/models/local/download/:action', models, async (req, res, next) => {
    try {
      services.localModelSetup?.assertIdle();
      if (!services.localModelDownloads)
        return res.status(503).json({ error: 'Model downloads are not available on this server.' });
      const manager = services.localModelDownloads;
      const result =
        req.params.action === 'start'
          ? manager.start(req.body)
          : req.params.action === 'cancel'
            ? await manager.cancel(req.body)
            : null;
      if (!result) return res.status(400).json({ error: 'Choose a supported download action.' });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/models/local/:action', models, async (req, res, next) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      services.localModelSetup?.assertIdle();
      if (!services.localModelRuntime)
        return res.status(503).json({ error: 'Local startup is not available on this server.' });
      let result;
      if (req.params.action === 'start')
        result = await services.localModelRuntime.start(req.body, controller.signal);
      else if (req.params.action === 'preference')
        result = await services.localModelRuntime.update(req.body);
      else return res.status(400).json({ error: 'Choose a supported local model action.' });
      if (!res.destroyed) res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      if (!res.destroyed) next(error);
    }
  });
  app.post('/api/models/capabilities', models, async (req, res, next) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const result = await services.provider.inspectAbilities(req.body, controller.signal);
      if (!res.destroyed) res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      if (!res.destroyed) next(error);
    }
  });
  app.post('/api/models/test', models, async (req, res, next) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      res.json(await services.provider.test(req.body, controller.signal));
    } catch (error) {
      if (!res.destroyed) next(error);
    }
  });
  const images = () => {
    if (!services.imageConnections)
      throw Object.assign(
        new Error(
          'Image generation is unavailable on this server. Update the Relay server to connect an image service.',
        ),
        { status: 503 },
      );
    return services.imageConnections;
  };
  app.get('/api/image-connection', (_req, res, next) => {
    try {
      res.json(images().publicState());
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/image-connection', (req, res, next) => {
    try {
      res.json(images().update(req.body));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/avatar/generate', async (req, res, next) => {
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', cancel);
    try {
      const result = await images().generate(req.body, controller.signal);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) next(error);
    } finally {
      res.off('close', cancel);
    }
  });
  app.get('/api/voice-connections', (_req, res, next) => {
    try {
      if (!services.voiceConnections)
        return res.status(503).json({ error: 'Voice setup is unavailable on this server.' });
      res.json(services.voiceConnections.publicState());
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/voice-connections/local', (_req, res, next) => {
    try {
      if (!services.localListeningInstallation)
        return res
          .status(503)
          .json({ error: 'Local listening setup is unavailable on this server.' });
      res.set('Cache-Control', 'no-store').json(services.localListeningInstallation.status());
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/voice-connections/local/:action', async (req, res, next) => {
    try {
      const setup = services.localListeningInstallation;
      if (!setup)
        return res
          .status(503)
          .json({ error: 'Local listening setup is unavailable on this server.' });
      const result =
        req.params.action === 'start'
          ? setup.start(req.body)
          : req.params.action === 'cancel'
            ? await setup.cancel(req.body)
            : null;
      if (!result)
        return res.status(400).json({ error: 'Choose a supported listening setup action.' });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/voice-connections/:kind/:action', async (req, res, next) => {
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', cancel);
    try {
      if (!services.voiceConnections)
        return res.status(503).json({ error: 'Voice setup is unavailable on this server.' });
      const { kind, action } = req.params;
      voiceCalls.sweep();
      const result =
        action === 'test'
          ? await services.voiceConnections.test(kind, req.body, controller.signal)
          : services.voiceConnections.update(kind, { ...req.body, action });
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) next(error);
    } finally {
      res.off('close', cancel);
    }
  });
  app.get('/api/voice-calls/:id', (req, res, next) => {
    try {
      voiceCalls.sweep();
      res.json({ call: voiceCalls.get(req.params.id) });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/voice-calls', (req, res, next) => {
    try {
      res.json({ call: voiceCalls.start(req.body.id, req.body.threadId, req.body.context) });
    } catch (error) {
      next(error);
    }
  });
  app.post(
    '/api/voice-calls/:id/:action',
    express.raw({ type: 'audio/*', limit: '8mb' }),
    async (req, res, next) => {
      const controller = new AbortController();
      const cancel = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once('close', cancel);
      try {
        const id = req.params.id,
          action = req.params.action;
        let result;
        if (action === 'turn')
          result = {
            turn: await voiceCalls.turn(
              id,
              req.query.turn,
              req.body,
              req.get('content-type'),
              controller.signal,
            ),
          };
        else if (action === 'reply')
          result = { card: await voiceCalls.reply(id, req.body.messageId, controller.signal) };
        else if (action === 'reply-stream') {
          const write = async (value) => {
            controller.signal.throwIfAborted();
            if (!res.headersSent)
              res.set({
                'Content-Type': 'application/x-ndjson',
                'Cache-Control': 'no-store',
                'X-Accel-Buffering': 'no',
              });
            if (!res.write(JSON.stringify(value) + '\n'))
              await once(res, 'drain', { signal: controller.signal });
          };
          const card = await voiceCalls.reply(id, req.body.messageId, controller.signal, (part) =>
            write({ type: 'audio', ...part, audio: part.audio.toString('base64') }),
          );
          await write({ type: 'done', card });
          res.end();
          return;
        } else if (['heartbeat', 'listen', 'resume', 'interrupt', 'end'].includes(action))
          result = { call: voiceCalls[action](id) };
        else return res.status(404).json({ error: 'Unknown voice action.' });
        if (!res.destroyed) res.json(result);
      } catch (error) {
        if (!res.destroyed) {
          if (res.headersSent)
            res.end(JSON.stringify({ type: 'error', error: error.message }) + '\n');
          else next(error);
        }
      } finally {
        res.off('close', cancel);
      }
    },
  );
  app.post('/api/messages/:id/voice', async (req, res, next) => {
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', cancel);
    try {
      if (!services.speech)
        return res.status(503).json({ error: 'Voice replies are not configured.' });
      const card = await services.speech.forMessage(store, req.params.id, controller.signal);
      if (!res.destroyed) res.json({ card });
    } catch (error) {
      if (!res.destroyed) next(error);
    } finally {
      res.off('close', cancel);
    }
  });
  app.get('/api/voice-memos/:id/audio', (req, res) => {
    const memo = store.voiceMemo(req.params.id);
    if (!memo) return res.status(404).json({ error: 'Voice recording not found.' });
    const audio = Buffer.from(memo.audio);
    res.set({
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="relay-voice.wav"`,
    });
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      let start = match?.[1] ? Number(match[1]) : 0,
        end = match?.[2] ? Number(match[2]) : audio.length - 1;
      if (match && !match[1] && match[2]) {
        start = Math.max(0, audio.length - Number(match[2]));
        end = audio.length - 1;
      }
      if (
        !match ||
        (!match[1] && !match[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= audio.length
      )
        return res.status(416).set('Content-Range', `bytes */${audio.length}`).end();
      end = Math.min(end, audio.length - 1);
      return res
        .status(206)
        .set('Content-Range', `bytes ${start}-${end}/${audio.length}`)
        .send(audio.subarray(start, end + 1));
    }
    res.send(audio);
  });
  app.post(
    '/api/transcribe',
    express.raw({ type: 'audio/*', limit: '8mb' }),
    async (req, res, next) => {
      const controller = new AbortController();
      const cancel = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once('close', cancel);
      try {
        if (!services.transcription?.configured)
          return res.status(503).json({
            error: 'Set up listening in Settings to use voice input.',
          });
        const result = await services.transcription.transcribe(
          req.body,
          req.get('content-type'),
          controller.signal,
        );
        if (!res.destroyed) res.json(result);
      } catch (error) {
        if (!res.destroyed) next(error);
      } finally {
        res.off('close', cancel);
      }
    },
  );
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    let closed = false;
    let heartbeat;
    const cleanup = () => {
      closed = true;
      clearInterval(heartbeat);
      store.off('change', emit);
      streams.delete(check);
    };
    const check = () => {
      if (closed) return false;
      if (authenticated(req)) return true;
      // An already-open stream must not outlive its cookie's authorization.
      res.write('event: signin\ndata: {}\n\n');
      cleanup();
      res.end();
      return false;
    };
    const emit = () => {
      if (check()) res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    };
    streams.add(check);
    store.on('change', emit);
    heartbeat = setInterval(() => {
      if (check()) res.write(': keepalive\n\n');
    }, 15000);
    req.on('close', cleanup);
    emit();
  });
  app.post('/api/command', async (req, res, next) => {
    try {
      const { action, payload = {} } = req.body;
      if (
        typeof action !== 'string' ||
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      )
        throw new Error('Use a workspace action and an object payload.');
      if (action === 'group.update') {
        const thread = store.read().threads.find((t) => t.id === payload.id);
        if (
          thread?.participantIds &&
          JSON.stringify(thread.participantIds) !== JSON.stringify(payload.participantIds)
        ) {
          assertGroupComputerIdle(store, services.computer, thread.id);
        }
      }
      const result =
        action === 'chat.retry'
          ? retryReply(store, services, payload)
          : store.mutate((s) =>
              command(s, action, payload, false, services.connectors?.chatCatalog() || []),
            );
      if (action === 'chat.send' && result?.stopControlId)
        services.worker?.stopChat(result.stopControlId);
      if (action === 'chat.stop' || action === 'task.action') services.worker?.abort(payload.id);
      if (action === 'handoff.cancel') {
        for (const id of result.runIds) services.worker?.abort(id);
        for (const job of services.computer?.jobs?.rows?.() || [])
          if (
            result.runIds.includes(job.runId) &&
            ['starting', 'running', 'paused', 'uncertain'].includes(job.status)
          )
            await services.computer.jobs.stop(job.id);
      }
      if (action === 'routine.archive')
        for (const r of store
          .read()
          .runs.filter((r) => r.routineId === payload.id && r.status === 'cancelled'))
          services.worker?.abort(r.id);
      res.json({ result, state: snapshot() });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/files/:id/email', async (req, res, next) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const file = store.read().files.find((f) => f.id === req.params.id);
      if (!file) return res.status(404).json({ error: 'File not found.' });
      const result = await readEmail(file, {
        offset: req.query.offset === undefined ? 0 : Number(req.query.offset),
        contentHash: req.query.contentHash,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) res.json(result);
    } catch (error) {
      if (!controller.signal.aborted) next(error);
    }
  });
  app.post('/api/files/:id/email/attachments', async (req, res, next) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const result = await importEmailAttachment(
        store,
        { id: req.params.id, index: req.body.index, contentHash: req.body.contentHash },
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) res.json({ result });
    } catch (error) {
      if (!controller.signal.aborted) next(error);
    }
  });
  app.get('/api/files/:id/office', async (req, res, next) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const file = store.read().files.find((f) => f.id === req.params.id);
      if (!file) return res.status(404).json({ error: 'File not found.' });
      const preview = await readOffice(file, {
        offset: req.query.offset === undefined ? 0 : Number(req.query.offset),
        contentHash: req.query.contentHash,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) res.json(preview);
    } catch (error) {
      if (!controller.signal.aborted) next(error);
    }
  });
  app.get('/api/files/:id', async (req, res, next) => {
    try {
      const f = store.read().files.find((f) => f.id === req.params.id);
      if (!f) return res.status(404).json({ error: 'File not found.' });
      const bytes = await fileBytes(f);
      res.set('Content-Type', f.mime === 'text/html' ? 'text/plain' : f.mime);
      res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      res.send(Buffer.from(bytes));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/google/start', (req, res, next) => {
    try {
      const auth = services.google.authorization(!!req.body.write);
      res.cookie('relay_oauth', auth.state, {
        httpOnly: true,
        sameSite: 'lax',
        secure: origin.startsWith('https:'),
        maxAge: 600000,
      });
      res.json({ url: auth.url });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/google/sync', async (req, res, next) => {
    try {
      res.json(await services.google.sync(req.body));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/google/disconnect', async (_req, res, next) => {
    try {
      await services.google.disconnect();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/google/thread/:id', async (req, res, next) => {
    try {
      res.json({ messages: await services.google.readThread(req.params.id) });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/google/attachment', async (req, res, next) => {
    try {
      const generation = store.read().connections.google.generation;
      const f = await services.google.importAttachment(req.body.id, req.body.attachmentId);
      const result = store.mutate((s) => {
        if (s.connections.google.generation !== generation)
          throw new Error('The connected account changed. Import this file again.');
        const file = command(s, 'file.add', f);
        const m = s.mail.find((m) => m.id === req.body.id);
        if (m) m.attachmentIds = [...(m.attachmentIds || []), file.id];
        return file;
      });
      res.json({ result });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/browser', async (_req, res, next) => {
    try {
      res.json(await services.browser.snapshot());
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/browser/navigate', async (req, res, next) => {
    try {
      res.json(await services.browser.navigate(req.body.url));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/browser/control', async (req, res, next) => {
    try {
      res.json(await services.browser.control(req.body));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/browser/stop', async (_req, res, next) => {
    try {
      await services.browser.stop();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  const computer = () => {
    if (!services.computer?.enabled)
      throw Object.assign(new Error('The private computer is not enabled on this server.'), {
        status: 503,
      });
    return services.computer;
  };
  const teaching = () => {
    computer();
    if (!services.teaching) throw new Error('Teaching is unavailable.');
    return services.teaching;
  };
  app.get('/api/teaching', (_req, res, next) => {
    try {
      res.json(teaching().state());
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/teaching/:id/frames/:frame', (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'no-store')
        .type('image/jpeg')
        .send(teaching().frame(req.params.id, req.params.frame));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/teaching/start', async (req, res, next) => {
    try {
      res.json(await teaching().start(req.body.goal, req.body.threadId));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/teaching/:id/:action', async (req, res, next) => {
    try {
      const service = teaching(),
        id = req.params.id,
        p = req.body || {};
      const actions = {
        heartbeat: () => service.heartbeat(id),
        pause: () => service.pause(id),
        resume: () => service.resume(id),
        finish: () => service.finish(id),
        capture: () => service.captureNow(id),
        removeFrame: () => service.removeFrame(id, p.frameId),
        discard: () => service.discard(id),
        generate: () => service.generate(id, p.version),
        save: () => service.saveSkill(id, p),
        test: () => service.test(id, p.input),
      };
      if (!Object.hasOwn(actions, req.params.action))
        return res.status(404).json({ error: 'Teaching action not found.' });
      res.json(await actions[req.params.action]());
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/computer/setup', (_req, res) => {
    res.json(services.computerSetup?.status() || { available: false, phase: 'idle', busy: false });
  });
  app.get('/api/computer/installation', async (_req, res, next) => {
    try {
      res
        .set('Cache-Control', 'no-store')
        .json((await services.computerSetup?.installation?.status()) || { available: false });
    } catch (error) {
      next(error);
    }
  });
  for (const action of ['start', 'cancel'])
    app.post(`/api/computer/installation/${action}`, async (req, res, next) => {
      try {
        const installation = services.computerSetup?.installation;
        if (!installation)
          return res.status(503).json({ error: 'Private computer installation is unavailable.' });
        res.json(await installation[action](req.body));
      } catch (error) {
        next(error);
      }
    });
  app.get('/api/computer/engine', async (_req, res, next) => {
    try {
      res.json((await services.computerSetup?.engineControl?.status()) || { available: false });
    } catch (error) {
      next(error);
    }
  });
  for (const action of ['start', 'cancel', 'resume', 'continueChat'])
    app.post(`/api/computer/engine/${action}`, async (_req, res, next) => {
      try {
        const engine = services.computerSetup?.engineControl;
        if (!engine) return res.status(503).json({ error: 'Runtime recovery is unavailable.' });
        if (action === 'resume' || action === 'continueChat') {
          const recording = services.teaching
            ?.state()
            .sessions.find((s) => ['recording', 'paused'].includes(s.status));
          if (recording) services.teaching.finish(recording.id);
        }
        res.json(await engine[action]());
      } catch (error) {
        next(error);
      }
    });
  app.get('/api/computer/maintenance', (_req, res) => {
    res.json(services.computerMaintenance?.status() || { available: false });
  });
  computerBackupRoutes(app, services.computerSnapshots);
  app.get('/api/computer/snapshots', (_req, res) => {
    res.json(services.computerSnapshots?.status() || { available: false });
  });
  for (const action of ['save', 'prepare', 'apply', 'cancel', 'retry'])
    app.post(`/api/computer/snapshots/${action}`, async (req, res, next) => {
      try {
        const snapshots = services.computerSnapshots;
        if (!snapshots)
          return res.status(503).json({ error: 'Restore points are unavailable on this server.' });
        const restoring =
          action === 'apply' && ['restore', 'fresh'].includes(snapshots.review?.kind);
        const result =
          action === 'prepare'
            ? await snapshots.prepare(req.body.kind, req.body.pointId)
            : action === 'retry'
              ? await snapshots.reconcile()
              : await snapshots[action](req.body.id);
        if (restoring) {
          const recording = services.teaching
            ?.state()
            .sessions.find((s) => ['recording', 'paused'].includes(s.status));
          if (recording) services.teaching.finish(recording.id);
        }
        res.json(result);
      } catch (error) {
        next(error);
      }
    });
  for (const action of ['prepare', 'apply', 'cancel'])
    app.post(`/api/computer/maintenance/${action}`, async (req, res, next) => {
      try {
        if (!services.computerMaintenance)
          return res
            .status(503)
            .json({ error: 'Computer maintenance is unavailable on this server.' });
        const result = await services.computerMaintenance[action](
          action === 'prepare' ? req.body.kind : req.body.id,
        );
        if (action === 'apply') {
          const recording = services.teaching
            ?.state()
            .sessions.find((s) => ['recording', 'paused'].includes(s.status));
          if (recording) services.teaching.finish(recording.id);
        }
        res.json(result);
      } catch (error) {
        next(error);
      }
    });
  for (const action of ['start', 'cancel'])
    app.post(`/api/computer/setup/${action}`, async (_req, res, next) => {
      try {
        if (!services.computerSetup)
          return res.status(503).json({ error: 'Computer setup is unavailable on this server.' });
        res.json(await services.computerSetup[action]());
      } catch (error) {
        next(error);
      }
    });
  app.get('/api/computer', async (_req, res, next) => {
    try {
      res.json({ ...(await computer().status()), receipts: computer().receipts() });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/computer/screen', async (_req, res, next) => {
    try {
      const ticket = services.teaching?.ticket();
      const screen = await computer().screenshot();
      services.teaching?.capture(ticket, screen);
      res.json({ ...screen, receipts: computer().receipts() });
    } catch (e) {
      next(e);
    }
  });
  for (const action of ['start', 'stop', 'takeControl', 'release', 'cancel'])
    app.post(`/api/computer/${action}`, async (_req, res, next) => {
      try {
        if (['release', 'stop'].includes(action)) {
          const recording = services.teaching
            ?.state()
            .sessions.find((s) => ['recording', 'paused'].includes(s.status));
          if (recording) services.teaching.finish(recording.id);
        }
        const engine = services.computerSetup?.engineControl;
        res.json(
          (action === 'stop' && engine
            ? await engine.stop({ beforeSleep: () => services.privateBrowser?.sleep() })
            : await computer()[action]('owner')) || { ok: true },
        );
      } catch (e) {
        next(e);
      }
    });
  app.get('/api/computer/websites', (req, res, next) => {
    try {
      const network = computer().network;
      res.json({
        ...(network?.status() || { enabled: false, sites: [] }),
        ...(req.query.runId && req.query.host && network
          ? { request: network.waitState(String(req.query.runId), String(req.query.host)) }
          : {}),
      });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/computer/websites/request', async (req, res, next) => {
    try {
      res.json(await computer().requestWebsite(req.body.url, 'Added by you.'));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/computer/websites/decide', async (req, res, next) => {
    try {
      res.json(await computer().decideWebsite(req.body.host, req.body.decision, req.body.runId));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/computer/websites/open', async (req, res, next) => {
    try {
      const ticket = services.teaching?.ticket();
      const result = await computer().openWebsite(req.body.url, { actor: 'owner' });
      services.teaching?.note(ticket, { kind: 'desktop', action: 'open_url' });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/computer/clipboard', async (req, res, next) => {
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', cancel);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await computer().copyClipboard(req.body.action, { signal: controller.signal });
      if (!res.destroyed) res.json(result);
    } catch (e) {
      if (!res.destroyed) next(e);
    } finally {
      res.off('close', cancel);
    }
  });
  app.post('/api/computer/action', async (req, res, next) => {
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', cancel);
    try {
      const ticket = services.teaching?.ticket();
      const result = await computer().perform(req.body, {
        actor: 'owner',
        signal: controller.signal,
      });
      if (!result.repeated) services.teaching?.note(ticket, req.body);
      if (!res.destroyed) res.json(result);
    } catch (e) {
      if (!res.destroyed) next(e);
    } finally {
      res.off('close', cancel);
    }
  });
  app.get('/api/computer/jobs', (_req, res, next) => {
    try {
      res.json({ jobs: computer().jobs.list() });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/computer/jobs/:id', (req, res, next) => {
    try {
      res.json(computer().jobs.public(computer().jobs.get(req.params.id)));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/computer/jobs/:id/stop', async (req, res, next) => {
    try {
      res.json(await computer().jobs.stop(req.params.id));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/computer/jobs/:id/input', async (req, res, next) => {
    try {
      res.json(
        await computer().jobs.input({
          id: req.params.id,
          data: req.body.data,
          operationId: req.body.operationId,
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/computer/files', async (req, res, next) => {
    try {
      res.json(await computer().list(String(req.query.path || '.')));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/computer/import', async (req, res, next) => {
    try {
      const file = store.read().files.find((f) => f.id === req.body.fileId);
      if (!file) throw new Error('Choose a saved file to copy to the computer.');
      res.json(
        await computer().perform(
          {
            kind: 'files',
            action: 'write',
            path: req.body.path || file.name,
            base64: Buffer.from(await fileBytes(file)).toString('base64'),
            operationId: req.body.operationId,
          },
          { actor: 'owner' },
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/computer/export', async (req, res, next) => {
    try {
      const file = await computer().read(req.body.path);
      const result = store.mutate((s) =>
        command(s, 'file.add', { ...file, mime: computerMime(file.name) }),
      );
      res.json({ id: result.id, name: result.name });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/export', (_req, res) => {
    res.set('Content-Disposition', 'attachment; filename="relay-workspace.json"');
    res.json({ ...snapshot(), voiceMemos: store.exportVoiceMemos() });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return;
    res.status(err.status || 400).json({
      error:
        err.type === 'entity.too.large'
          ? 'Use a file smaller than 8 MB.'
          : err.message || 'The request failed.',
    });
  });
  return app;
}
export function computerMime(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  return (
    {
      pdf: 'application/pdf',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      html: 'text/html',
      py: 'text/plain',
      js: 'text/plain',
    }[ext] || 'application/octet-stream'
  );
}
