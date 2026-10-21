// SPDX-License-Identifier: MIT
// Public, unauthenticated compatibility checks only: no registration or account grants.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import { appDirectory } from '../server/app-directory.mjs';
import { oauthFetch } from '../server/connector-oauth.mjs';
import { Connectors } from '../server/connectors.mjs';
import { Store } from '../server/store.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-directory-probe-'));
const store = new Store(':memory:', { sample: false });
const connectors = new Connectors(store, { key: modelVaultKey(directory), timeoutMs: 20000 });
const checks = [];
try {
  for (const app of appDirectory) {
    try {
      const preparation = await connectors.prepare({ name: app.name, endpoint: app.endpoint });
      assert.equal(preparation.signInRequired, true);
      const info = await discoverOAuthServerInfo(app.endpoint, {
        fetchFn: oauthFetch(app.endpoint),
      });
      const metadata = info.authorizationServerMetadata;
      assert.equal(info.resourceMetadata.resource, app.endpoint);
      assert.equal(new URL(metadata.issuer).href, new URL(info.authorizationServerUrl).href);
      assert(metadata.code_challenge_methods_supported.includes('S256'));
      assert(metadata.registration_endpoint);
      checks.push({
        id: app.id,
        endpoint: app.endpoint,
        passed: true,
        signInRequired: true,
        resourceMatches: true,
        issuer: metadata.issuer,
        pkce: 'S256',
        registrationAdvertised: true,
        guide: app.guide,
      });
    } catch (error) {
      checks.push({ id: app.id, endpoint: app.endpoint, passed: false, error: error.message });
    }
  }
  assert.equal(connectors.read().length, 0);
  assert.equal(connectors.oauth.flows().length, 0);
  const evidence = resolve('../relay-evidence');
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, 'app-directory-public-probe.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Unauthenticated MCP initialization rejection and public OAuth metadata only. No client registration, login, account authorization or tool execution. Does not certify account/plan availability.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(checks, null, 2));
  if (checks.some((c) => !c.passed)) process.exitCode = 1;
} finally {
  connectors.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
