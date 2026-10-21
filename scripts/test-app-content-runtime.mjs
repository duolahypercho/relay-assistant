// Independent Python MCP program, exercised inside a real disposable Relay computer.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { Connectors } from '../server/connectors.mjs';
import { command } from '../shared/domain.mjs';
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
const directory = await mkdtemp(join(tmpdir(), 'relay-content-runtime-'));
const store = new Store(join(directory, 'state.sqlite'), { sample: false });
const computer = new PrivateComputer(store, {
  enabled: true,
  deployment: directory,
  image: process.env.RELAY_TEST_COMPUTER_IMAGE || 'relay-desktop:local',
  dockerHost: process.env.RELAY_COMPUTER_TEST_DOCKER_HOST,
});
const connectors = new Connectors(store, { key: randomBytes(32), computer, timeoutMs: 20000 });
const program = `import sys,json,time
from pathlib import Path
for line in sys.stdin:
 p=json.loads(line)
 if 'id' not in p:continue
 method=p['method'];args=p.get('params',{})
 if method=='initialize':result={'protocolVersion':'2025-06-18','capabilities':{'resources':{},'prompts':{},'completions':{}},'serverInfo':{'name':'Local library','version':'1'}}
 elif method=='resources/list':result={'resources':[{'uri':'notes://local/plan','name':'Local plan'},{'uri':'notes://local/slow','name':'Slow note'}]}
 elif method=='resources/templates/list':result={'resourceTemplates':[{'uriTemplate':'notes://daily/{day}{?tag*}','name':'Daily note'}]}
 elif method=='prompts/list':result={'prompts':[{'name':'plan','arguments':[{'name':'mood','required':True}]}]}
 elif method=='completion/complete':
  if args['argument']['value']=='slow':Path('/workspace/options-started.txt').write_text('started');time.sleep(60)
  if args['ref']['type']=='ref/resource':
   assert args['ref']['uri']=='notes://daily/{day}{?tag*}'
   assert args['argument']['name']=='day' and args['context']['arguments']['tag']=='books'
   result={'completion':{'values':['Sunday'],'hasMore':False}}
  else:result={'completion':{'values':['curious'],'hasMore':False}}
 elif method=='resources/read':
  if args['uri'].endswith('/slow'):Path('/workspace/content-started.txt').write_text('started');time.sleep(60)
  result={'contents':[{'uri':args['uri'],'text':'Local plan: meet at noon. '+args['uri']}]}
 elif method=='prompts/get':result={'messages':[{'role':'user','content':{'type':'text','text':'Make a '+args['arguments']['mood']+' local plan.'}}]}
 elif method=='ping':result={}
 else:
  print(json.dumps({'jsonrpc':'2.0','id':p['id'],'error':{'code':-32601,'message':'Unsupported'}}),flush=True);continue
 print(json.dumps({'jsonrpc':'2.0','id':p['id'],'result':result}),flush=True)
`;
const checks = [];
try {
  await computer.start();
  await computer.perform({
    kind: 'files',
    action: 'write',
    path: 'content.py',
    base64: Buffer.from(program).toString('base64'),
    operationId: 'content-program',
  });
  const found = await connectors.prepare({
    transport: 'stdio',
    name: 'Local library',
    launchApproved: true,
    launch: { command: 'python3', args: ['/workspace/content.py'], env: {} },
  });
  assert.equal(found.connection.tools.length, 4);
  assert(found.connection.tools.every((t) => t.mode === 'ask'));
  assert.equal(computer.stdio.rows().length, 0);
  const saved = connectors.save({
    discoveryId: found.discoveryId,
    permissions: Object.fromEntries(
      found.connection.tools.map((t) => [t.name, t.ownerChoice ? 'ask' : 'auto']),
    ),
  }).connections[0];
  const payload = (t, args = {}) => ({
    connectionId: saved.id,
    revision: saved.revision,
    toolName: t.name,
    fingerprint: t.fingerprint,
    arguments: args,
  });
  const plan = saved.tools.find((t) => t.contentTarget.uri === 'notes://local/plan');
  const read = await connectors.call(payload(plan), 'relay', 'local:read');
  assert.match(read.content[0].text, /meet at noon/);
  await connectors.call(payload(plan), 'relay', 'local:read');
  assert.equal(computer.stdio.rows().length, 0);
  checks.push('real isolated stdio content-only discovery, resource read and durable receipt');
  const daily = saved.tools.find((t) => t.kind === 'resource-template');
  const note = await connectors.call(
    payload(daily, { day: 'Sunday', tag: ['books', 'tea'] }),
    'relay',
    'local:daily',
  );
  assert.match(note.content[0].text, /notes:\/\/daily\/Sunday\?tag=books&tag=tea/);
  const prompt = saved.tools.find((t) => t.kind === 'prompt');
  await assert.rejects(
    connectors.call(payload(prompt, { mood: 'quiet' }), 'relay', 'local:unreviewed'),
    /exact owner review/,
  );
  const run = store.mutate((s) =>
    command(s, 'chat.send', { threadId: 'main', text: 'Use my local planning template.' }),
  );
  const { review } = await connectors.invoke(payload(prompt, { mood: 'quiet' }), {
    assistantId: 'relay',
    threadId: 'main',
    runId: run.id,
    operationId: 'local:prompt',
  });
  const editor = connectors.promptEditor(review.id);
  assert(editor.canSuggest);
  const lookup = {
    id: review.id,
    reviewToken: editor.reviewToken,
    field: 'mood',
    arguments: { mood: 'cu' },
  };
  assert.deepEqual(await connectors.suggestPrompt(lookup), { values: ['curious'], hasMore: false });
  const documentLookup = {
    threadId: 'main',
    ...payload(daily, { day: 'Su', tag: 'books' }),
    field: 'day',
  };
  assert.deepEqual(await connectors.suggestDocument(documentLookup), {
    values: ['Sunday'],
    hasMore: false,
  });
  const pickedInput = {
    threadId: 'main',
    ...payload(prompt, { mood: 'quiet' }),
    operationId: '1373a0b3-6bc8-411f-b90a-1dc211c884dc',
  };
  assert.equal(connectors.templates(pickedInput).entries.length, 1);
  const picked = await connectors.useTemplate(pickedInput);
  assert.deepEqual(await connectors.useTemplate(pickedInput), picked);
  assert(
    store
      .read()
      .runs.find((r) => r.id === picked.runId)
      .templateContext.result.content.some((c) => c.text?.includes('Make a quiet local plan.')),
  );
  checks.push(
    'direct owner-picked template uses isolated prompts/get and creates one durable chat request without a second review',
  );
  const cancelled = new AbortController();
  const optionsWaiting = connectors
    .suggestDocument(
      { ...documentLookup, arguments: { day: 'slow', tag: 'books' } },
      cancelled.signal,
    )
    .catch((error) => error);
  let optionsStarted = false;
  for (let i = 0; i < 80; i++) {
    try {
      optionsStarted = !!(await computer.read('options-started.txt')).base64;
    } catch {}
    if (optionsStarted) break;
    await delay(100);
  }
  assert(optionsStarted);
  cancelled.abort();
  assert((await optionsWaiting) instanceof Error);
  assert.equal(computer.stdio.rows().length, 0);
  assert.equal(store.read().approvals.find((a) => a.id === review.id).status, 'pending');
  checks.push(
    'prompt and resource completion through a real isolated stdio app; exact URI/field/context and cancellation stopping its process without retrieving content',
  );
  connectors.usePrompt({
    id: review.id,
    reviewToken: editor.reviewToken,
    arguments: { mood: 'curious' },
  });
  const approved = store.mutate((s) => {
    const a = s.approvals.find((item) => item.id === review.id);
    a.status = 'executing';
    return a;
  });
  const template = await connectors.executeApproval(approved);
  assert.match(template.content[1].text, /Make a curious local plan/);
  assert.equal(computer.stdio.rows().length, 0);
  checks.push(
    'RFC6570 template expansion and owner-edited template values retrieved through the isolated guest process',
  );
  const slow = saved.tools.find((t) => t.contentTarget.uri === 'notes://local/slow');
  const waiting = connectors.call(payload(slow), 'relay', 'local:takeover').catch((e) => e);
  let started = false;
  for (let i = 0; i < 60; i++) {
    try {
      started = !!(await computer.read('content-started.txt')).base64;
    } catch {}
    if (started) break;
    await delay(100);
  }
  assert(started);
  await computer.takeControl();
  assert.equal((await waiting).name, 'UncertainActionError');
  assert.equal(computer.stdio.rows().length, 0);
  await assert.rejects(
    connectors.call(payload(slow), 'relay', 'local:takeover'),
    /no confirmed result/,
  );
  checks.push(
    'owner takeover terminates an in-flight resource session and uncertain reads do not replay',
  );
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, 'app-content-runtime.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), passed: true, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  connectors.close();
  await computer.stop().catch(() => {});
  await computer.checked(['rm', '-f', computer.name]).catch(() => {});
  for (const volume of [computer.volume, computer.displayVolume])
    await computer.checked(['volume', 'rm', volume]).catch(() => {});
  store.close();
  await rm(directory, { recursive: true, force: true });
}
