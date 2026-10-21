// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { command } from '../shared/domain.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-pty-real-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let store = new Store(join(directory, 'state.sqlite'), { sample: false });
let computer = new PrivateComputer(store, { enabled: true, deployment: directory });
const checks = [];
function check(name) {
  checks.push(name);
  console.log('PASS', name);
}
function request() {
  return store.mutate((s) =>
    command(s, 'chat.send', { threadId: 'main', text: 'Complete this interactive program.' }),
  );
}
function finish(run) {
  store.mutate((s) => {
    s.runs.find((r) => r.id === run.id).status = 'completed';
  });
}
const python = (code) => "python3 -u -c '" + code.replaceAll("'", "'\\''") + "'";
async function start(code, operationId) {
  const run = request();
  const job = await computer.jobs.start(
    { title: operationId, operationId, pty: true, command: python(code), seconds: 240 },
    { runId: run.id },
  );
  finish(run);
  return job;
}
async function until(id, condition) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    await computer.jobs.poll();
    const job = computer.jobs.get(id);
    if (condition(job)) return job;
    if (['failed', 'timed_out', 'interrupted'].includes(job.status))
      throw new Error(JSON.stringify(job));
    await delay(150);
  }
  throw new Error(
    'Interactive job did not reach its expected state: ' + JSON.stringify(computer.jobs.get(id)),
  );
}
const read = async (path) => Buffer.from((await computer.read(path)).base64, 'base64').toString();
try {
  await computer.start();
  const job = await start(
    `import os,sys,pathlib
print('TTY',sys.stdin.isatty(),sys.stdout.isatty(),sys.stderr.isatty(),os.get_terminal_size())
with open('/dev/tty') as terminal: print('Controlling terminal ready')
name=input('Name? ')
pathlib.Path('/workspace/pty-name.txt').write_text(name)
print('Saved name:',name)
color=input('Color? ')
pathlib.Path('/workspace/pty-result.txt').write_text(name+' / '+color)
print('Finished:',name,color)`,
    'two-prompts',
  );
  const initial = await until(job.id, (j) => j.result.stdout.includes('Name?'));
  assert.match(initial.result.stdout, /TTY True True True/);
  assert.match(initial.result.stdout, /columns=100, lines=30/);
  assert.match(initial.result.stdout, /Controlling terminal ready/);
  assert.equal(initial.pty, true);
  check(
    'Real stdin/stdout/stderr TTY, controlling terminal, fixed dimensions and unbuffered prompt output',
  );
  const input = { id: job.id, operationId: 'name', data: 'Renée\n' };
  const rpc = computer.rpc.bind(computer);
  let lost = false;
  computer.rpc = async (p, target) => {
    const result = await rpc(p, target);
    if (p.action === 'input' && !lost) {
      lost = true;
      throw new Error('Lost input acknowledgement');
    }
    return result;
  };
  await assert.rejects(computer.jobs.input(input), /Lost input acknowledgement/);
  assert.equal((await computer.jobs.input(input)).repeated, true);
  await until(job.id, (j) => j.result.stdout.includes('Color?'));
  assert.equal(await read('pty-name.txt'), 'Renée');
  await assert.rejects(computer.jobs.input({ ...input, data: 'different\n' }), /different text/);
  check(
    'Lost-acknowledgement retry sends one Unicode line, and changed text cannot reuse its operation ID',
  );
  await computer.shutdown();
  store.close();
  store = new Store(join(directory, 'state.sqlite'), { sample: false });
  computer = new PrivateComputer(store, { enabled: true, deployment: directory });
  assert.equal((await computer.jobs.input(input)).repeated, true);
  await computer.takeControl();
  await assert.rejects(
    computer.jobs.input({ id: job.id, operationId: 'color', data: 'sage\n' }),
    /Give control back/,
  );
  assert.equal((await computer.runtime.inspect()).State.Paused, true);
  await computer.release();
  await computer.jobs.input({ id: job.id, operationId: 'color', data: 'sage\n' });
  await until(job.id, (j) => j.status === 'completed');
  assert.equal(await read('pty-result.txt'), 'Renée / sage');
  assert.equal((await computer.jobs.input(input)).repeated, true);
  await assert.rejects(
    computer.jobs.input({ ...input, operationId: 'late' }),
    /not accepting input/,
  );
  assert.equal(store.read().runs.filter((r) => r.jobContext?.id === job.id).length, 1);
  check(
    'Same PTY survives service reopen; takeover blocks input; handback completes once with exact file bytes and no late replay',
  );
  const interrupted = await start(
    `import sys
print('Ready to interrupt')
try: input('Waiting: ')
except KeyboardInterrupt:
 print('Interrupt received')
 sys.exit(73)`,
    'interrupt',
  );
  await until(interrupted.id, (j) => j.result.stdout.includes('Waiting:'));
  await computer.jobs.input({ id: interrupted.id, operationId: 'interrupt', data: '\u0003' });
  const ended = await until(interrupted.id, (j) => j.status === 'failed');
  assert.equal(ended.result.exitCode, 73);
  assert.match(ended.result.stdout, /Interrupt received/);
  check(
    'Ctrl-C reaches the foreground program, preserves its output and exit status, and leaves the computer running',
  );
  const eof = await start(
    `import sys
print('x'*40000, file=sys.stderr)
print('End input: ',end='',flush=True)
try: input()
except EOFError: print('EOF received')`,
    'eof',
  );
  const tail = await until(eof.id, (j) => j.result.stdout.includes('End input:'));
  assert.equal(tail.result.truncated, true);
  assert.ok(tail.result.stdout.length <= 32000);
  assert.equal(tail.result.stderr, '');
  await computer.jobs.input({ id: eof.id, operationId: 'eof', data: '\u0004' });
  assert.match(
    (await until(eof.id, (j) => j.status === 'completed')).result.stdout,
    /EOF received/,
  );
  check('EOF works; merged PTY output is retained as a bounded tail');
  const stopped = await start("print('Waiting for stop',flush=True); input()", 'stop-frozen');
  await until(stopped.id, (j) => j.result.stdout.includes('Waiting for stop'));
  await computer.takeControl();
  assert.equal((await computer.jobs.stop(stopped.id)).status, 'cancelled');
  assert.equal((await computer.runtime.inspect()).State.Paused, true);
  await computer.release();
  await computer.jobs.poll();
  assert.equal(computer.jobs.get(stopped.id).status, 'cancelled');
  check('A frozen interactive job can be cancelled without thawing its command runtime');
  await writeFile(
    join(evidence, 'computer-interactive-acceptance.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        runtime: 'Actual private Docker Linux computer; real PTY and Python programs',
        checks,
      },
      null,
      2,
    ),
  );
  console.log(`${checks.length} real interactive-computer checks passed.`);
} finally {
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.runtime.name, computer.name]).catch(() => {});
  await computer
    .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
    .catch(() => {});
  store.close();
  await rm(directory, { recursive: true, force: true });
}
