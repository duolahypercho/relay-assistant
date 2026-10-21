// SPDX-License-Identifier: MIT
const path = '/api/connectors/oauth';
const cookies = (req) =>
  Object.fromEntries((req.headers.cookie || '').split(';').map((v) => v.trim().split('=')));
const screen = (res, ok) =>
  res
    .status(ok ? 200 : 400)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App sign-in · Relay</title><style>body{font:17px/1.6 system-ui,sans-serif;color:#233a34;background:#f8faf7;margin:0;min-height:100dvh;display:grid;place-items:center}main{max-width:26rem;padding:2rem}h1{font-size:1.8rem;line-height:1.2}p{color:#52645d}</style><main><h1>${ok ? 'You’re signed in.' : 'Sign-in wasn’t completed.'}</h1><p>${ok ? 'Return to Relay to choose what your assistant can use. You can close this tab.' : 'Return to Relay and try signing in again. You can close this tab.'}</p></main></html>`,
    );
export function publicConnectorOAuthRoutes(app, service, config) {
  const secure = (config.publicUrl || '').startsWith('https:');
  app.get(`${path}/open`, (req, res) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    try {
      const result = service.oauth.open(req.query.id, req.query.ticket);
      res.cookie(result.cookie, result.nonce, {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        maxAge: 600000,
        path: `${path}/callback`,
      });
      res.redirect(303, result.url);
    } catch {
      screen(res, false);
    }
  });
  app.get(`${path}/callback`, async (req, res) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    try {
      const id = await service.oauth.callback(req.query, cookies(req));
      res.clearCookie(`relay_app_${id.replaceAll('-', '')}`, {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        path: `${path}/callback`,
      });
      screen(res, service.oauth.flow(id)?.phase === 'authorized');
    } catch {
      screen(res, false);
    }
  });
}
export function ownerConnectorOAuthRoutes(app, service, config) {
  const requireService = () => {
    if (!service) throw Error('Connect to a Relay server to add apps.');
    return service.oauth;
  };
  app.post(`${path}/begin`, async (req, res, next) => {
    try {
      const origin = new URL(config.publicUrl || `http://${config.host}:${config.port}`);
      // Ephemeral local ports are used by independently hosted acceptance servers.
      if (config.port === 0) origin.port = String(req.socket.localPort);
      res.json(await requireService().begin(req.body, origin.href));
    } catch (error) {
      next(error);
    }
  });
  app.get(`${path}/result`, async (req, res, next) => {
    try {
      res.json(await requireService().result(req.query.id));
    } catch (error) {
      next(error);
    }
  });
  app.post(`${path}/cancel`, (req, res, next) => {
    try {
      res.json(requireService().cancel(req.body.id));
    } catch (error) {
      next(error);
    }
  });
}
