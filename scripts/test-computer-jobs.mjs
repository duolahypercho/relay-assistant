// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { command } from '../shared/domain.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-jobs-real-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let store = new Store(join(directory, 'state.sqlite'), { sample: false });
let computer = new PrivateComputer(store, { enabled: true, deployment: directory });
const checks = [];
const check = (label) => {
  checks.push(label);
  console.log('PASS', label);
};
function request(text) {
  return store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text }));
}
function finish(run) {
  store.mutate((s) => {
    s.runs.find((r) => r.id === run.id).status = 'completed';
  });
}
async function until(id, expected) {
  for (let i = 0; i < 25; i++) {
    await computer.jobs.poll();
    const job = computer.jobs.get(id);
    if (expected.includes(job.status)) return job;
    await delay(200);
  }
  throw new Error('Job did not reach ' + expected.join('/'));
}
try {
  await computer.start();
  const run = request('Create a durable report.');
  const spec = {
    operationId: 'report',
    title: 'Create report',
    seconds: 180,
    command: `python3 -u - <<'PY'
import time, pathlib
p=pathlib.Path('/workspace')
print('Job started', flush=True)
with (p/'job-ticks.txt').open('a',buffering=1) as f:
 while not (p/'finish-job').exists():
  f.write('tick\\n')
  time.sleep(.1)
(p/'background-result.txt').write_text('A real completed background report.')
print('Report saved', flush=True)
PY`,
  };
  const job = await computer.jobs.start(spec, { runId: run.id });
  finish(run);
  assert.ok(['starting', 'running'].includes(job.status));
  assert.equal((await computer.jobs.start(spec, { runId: run.id })).id, job.id);
  const live = await until(job.id, ['running']);
  assert.match(live.result.stdout, /Job started/);
  check(
    'A real job runs independently, exposes live logs, and the same operation ID does not launch twice',
  );
  assert.equal((await computer.shutdown()).detached, true);
  store.close();
  store = new Store(join(directory, 'state.sqlite'), { sample: false });
  computer = new PrivateComputer(store, { enabled: true, deployment: directory });
  assert.equal((await until(job.id, ['running'])).runtimeId, live.runtimeId);
  check('Service and SQLite reopen reconnect to the same live guest job');
  const siblingRun = request('Keep an independent job running.');
  const sibling = await computer.jobs.start(
    { operationId: 'sibling', title: 'Independent work', command: 'sleep 180', seconds: 240 },
    { runId: siblingRun.id },
  );
  finish(siblingRun);
  await computer.takeControl();
  assert.equal(computer.jobs.list()[0].status, 'paused');
  const read = async (path) => Buffer.from((await computer.read(path)).base64, 'base64').toString();
  const frozen = await read('job-ticks.txt');
  await delay(350);
  assert.equal(await read('job-ticks.txt'), frozen);
  const stopped = await computer.jobs.stop(job.id);
  assert.equal(stopped.status, 'cancelled');
  assert.equal((await computer.runtime.inspect()).State.Paused, true);
  await computer.release();
  await delay(250);
  assert.equal(await read('job-ticks.txt'), frozen);
  assert.equal((await until(sibling.id, ['running'])).status, 'running');
  await computer.jobs.stop(sibling.id);
  await computer.jobs.poll();
  assert.equal(store.read().runs.filter((r) => r.jobContext?.id === job.id).length, 0);
  check(
    'Stopping a frozen job kills only that job without unfreezing the runtime or creating a continuation',
  );
  const second = request('Create the final result.');
  const done = await computer.jobs.start(
    {
      operationId: 'complete',
      title: 'Save final result',
      seconds: 30,
      command: `python3 -u -c "import time; print('x'*100000); time.sleep(.2); open('/workspace/background-result.txt','w').write('A real completed background report.'); print('Final report ready')"`,
    },
    { runId: second.id },
  );
  finish(second);
  const completed = await until(done.id, ['completed']);
  assert.equal(completed.result.exitCode, 0);
  assert.equal(completed.result.truncated, true);
  assert.ok(completed.result.stdout.length <= 32000);
  assert.match(completed.result.stdout, /Final report ready/);
  assert.equal(await read('background-result.txt'), 'A real completed background report.');
  await computer.jobs.poll();
  assert.equal(store.read().runs.filter((r) => r.jobContext?.id === done.id).length, 1);
  assert.equal(store.read().messages.filter((m) => m.role === 'user').length, 3);
  check(
    'Completion retains a bounded output tail and actual file bytes, then queues the original task exactly once',
  );
  const timeoutRun = request('Run a bounded job.');
  const timeout = await computer.jobs.start(
    { operationId: 'timeout', title: 'Bounded work', command: 'sleep 30', seconds: 1 },
    { runId: timeoutRun.id },
  );
  finish(timeoutRun);
  assert.equal((await until(timeout.id, ['timed_out'])).result.exitCode, 124);
  check('Background time limits end the process group and preserve an honest timeout result');
  const lostRun = request('Keep work running.');
  const lost = await computer.jobs.start(
    { operationId: 'interrupted', title: 'Wait for work', command: 'sleep 120', seconds: 160 },
    { runId: lostRun.id },
  );
  finish(lostRun);
  await computer.stop();
  assert.equal(computer.jobs.get(lost.id).status, 'interrupted');
  await computer.start();
  await computer.jobs.poll();
  assert.equal(computer.jobs.get(lost.id).status, 'interrupted');
  assert.equal(await read('background-result.txt'), 'A real completed background report.');
  check(
    'Stopping and restarting the computer retains completed output/files and reports interrupted jobs without replay',
  );
  await writeFile(
    join(evidence, 'computer-jobs-acceptance.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        runtime: 'Real Linux background supervisor, Docker freezer and host SQLite',
        checks,
      },
      null,
      2,
    ),
  );
  console.log(`${checks.length} real background-job checks passed.`);
} catch (error) {
  const diagnostics = await Promise.allSettled([
    computer.dockerRun(['inspect', computer.name, computer.runtime.name]),
    computer.dockerRun(['logs', '--tail', '100', computer.name]),
  ]);
  await writeFile(
    join(evidence, 'computer-jobs-failure.json'),
    JSON.stringify(
      { testedAt: new Date().toISOString(), error: String(error), checks, diagnostics },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.runtime.name, computer.name]).catch(() => {});
  await computer
    .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
    .catch(() => {});
  store.close();
  await rm(directory, { recursive: true, force: true });
}
