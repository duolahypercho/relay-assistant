// SPDX-License-Identifier: MIT
// Register after the app's owner authentication, origin and host middleware.
export function trustedBrowserRoutes(app, browser) {
  const service = () => {
    if (!browser?.enabled)
      throw Object.assign(new Error('The private browser is not enabled on this server.'), {
        status: 503,
      });
    return browser;
  };
  const route = (fn) => async (req, res, next) => {
    try {
      res.json(await fn(service(), req));
    } catch (error) {
      next(error);
    }
  };
  app.get(
    '/api/private-browser',
    route((b) => ({ ...b.status('owner'), requests: b.requests.list() })),
  );
  app.get(
    '/api/private-browser/view',
    route((b) => b.ownerView()),
  );
  app.post(
    '/api/private-browser/actions/:id/cancel',
    route((b, req) => b.cancelAction(req.params.id)),
  );
  app.get(
    '/api/private-browser/screen',
    route((b) => b.ownerScreen()),
  );
  app.get(
    '/api/private-browser/accessibility',
    route((b) => b.observe('owner')),
  );
  app.get(
    '/api/private-browser/actions/:id',
    route((b, req) => b.action(req.params.id)),
  );
  // HTTP callers are owners. A supplied actor/guard never selects model authority.
  app.post(
    '/api/private-browser/actions',
    route((b, req) => b.begin(req.body, 'owner')),
  );
  app.post(
    '/api/private-browser/requests/:id',
    route((b, req) =>
      b.decide(req.params.id, req.body.fingerprint, req.body.allow, req.body.includePageResources),
    ),
  );
  app.post(
    '/api/private-browser/clear',
    route(async (b) => {
      b.assert('owner');
      await b.clear();
      return { ok: true };
    }),
  );
}
