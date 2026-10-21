// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const id = () => randomUUID().replaceAll('-', '');
const COPY_BODY = `import os,stat,shutil,json
source='/source'; target='/workspace'; count=0; size=0
# Both writers are frozen or stopped. Never follow a workspace symlink.
for root,dirs,files in os.walk(source,followlinks=False):
 for name in dirs+files:
  p=os.path.join(root,name); s=os.lstat(p); count+=1
  if stat.S_ISREG(s.st_mode): size+=s.st_size
  if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode) or stat.S_ISSOCK(s.st_mode)):
   raise RuntimeError('Restore points cannot contain device files or named pipes.')
  if count>200000 or size>8*1024**3: raise RuntimeError('Restore points support up to 8 GB and 200,000 files.')
def ignore(root,names):
 return [n for n in names if stat.S_ISSOCK(os.lstat(os.path.join(root,n)).st_mode)]
if os.listdir(target): raise RuntimeError('The new restore-point workspace is not empty.')
shutil.copytree(source,target,symlinks=True,dirs_exist_ok=True,ignore=ignore)
os.sync()
print(json.dumps({'files':count,'bytes':size}))
`;
const COPY = `import json
def save():
${COPY_BODY.split('\n')
  .map((line) => ' ' + line)
  .join('\n')}
try:
 save()
except RuntimeError as error:
 print(json.dumps({'error':str(error)}))
except Exception:
 print(json.dumps({'error':'Not all files could be saved. Check workspace access and free disk space, then try again.'}))
`;

// Copies stay in private Docker volumes. No archive or credential bytes enter HTTP,
// the model context, application exports, or the host filesystem.
export class ComputerSnapshots {
  constructor(computer) {
    this.computer = computer;
    this.db = computer.db;
    this.phase = 'idle';
    this.error = '';
    this.review = null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS computer_snapshots (
      id TEXT PRIMARY KEY, volume TEXT NOT NULL UNIQUE, created TEXT NOT NULL,
      label TEXT NOT NULL, bytes INTEGER, files INTEGER);
      CREATE TABLE IF NOT EXISTS computer_workspace_losses (
      replacement TEXT PRIMARY KEY, previous TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_snapshot_operation (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);`);
    computer.snapshotBlocked = !!this.storedOperation();
  }
  points() {
    return this.db
      .prepare('SELECT id,created,label,bytes,files FROM computer_snapshots ORDER BY created DESC')
      .all();
  }
  status() {
    return {
      available: this.computer.enabled,
      phase: this.phase,
      busy: !!this.pending,
      error: this.error,
      canRetry: !!this.storedOperation() && !this.pending,
      points: this.points(),
      review: this.review
        ? {
            id: this.review.id,
            kind: this.review.kind,
            point: this.review.point,
          }
        : null,
    };
  }
  journal(value) {
    this.db
      .prepare('INSERT OR REPLACE INTO computer_snapshot_operation VALUES (1,?)')
      .run(JSON.stringify(value));
  }
  storedOperation() {
    const row = this.db.prepare('SELECT payload FROM computer_snapshot_operation WHERE id=1').get();
    return row ? JSON.parse(row.payload) : null;
  }
  available() {
    this.computer.assertAvailable();
    if (!this.computer.enabled) throw fail('Set up the computer first.');
    if (this.pending) throw fail('Wait for the current restore-point operation.');
    if (this.storedOperation()) throw fail('Finish the interrupted restore-point operation first.');
  }
  prepare(kind, pointId) {
    if (kind === 'fresh') return this.prepareFresh();
    this.available();
    if (!['restore', 'remove'].includes(kind)) throw fail('Choose a restore point action.', 400);
    const point = this.points().find((p) => p.id === pointId);
    if (!point) throw fail('This restore point is no longer available.', 404);
    if (kind === 'restore' && this.points().length >= 10)
      throw fail(
        'Remove an older restore point before restoring. Relay keeps a point from just before each restore.',
      );
    this.error = '';
    this.phase = 'review';
    this.review = { id: randomUUID(), kind, point, active: this.computer.volume };
    return this.status();
  }
  async assertMissingWorkspace() {
    const p = this.computer;
    if (!p.workspaceInitialized || (await p.workspaceExists()))
      throw fail('Your saved workspace is available. Refresh Computer before choosing recovery.');
    if ((await p.inspect()) || (await p.runtime.inspect()))
      throw fail(
        'The computer still has attached processes. Ask the server owner to inspect it before recovery.',
      );
  }
  async prepareFresh() {
    this.available();
    const active = this.computer.volume;
    await this.assertMissingWorkspace();
    this.available();
    if (active !== this.computer.volume) throw fail('The computer changed. Review recovery again.');
    this.error = '';
    this.phase = 'review';
    this.review = { id: randomUUID(), kind: 'fresh', active, point: null };
    return this.status();
  }
  cancel() {
    if (this.pending) throw fail('Wait for the restore point to finish.');
    this.review = null;
    this.phase = 'idle';
    this.error = '';
    return this.status();
  }
  apply(reviewId) {
    this.available();
    const plan = this.review;
    if (!plan || plan.id !== reviewId || plan.active !== this.computer.volume)
      throw fail('Review this restore point again before continuing.');
    if (plan.kind === 'fresh') {
      this.review = null;
      return this.run('restoring', () => this.startFresh());
    }
    const row = this.db.prepare('SELECT * FROM computer_snapshots WHERE id=?').get(plan.point.id);
    if (!row) throw fail('This restore point is no longer available.', 404);
    this.review = null;
    return this.run(plan.kind === 'restore' ? 'restoring' : 'removing', () =>
      plan.kind === 'restore' ? this.restore(row) : this.remove(row),
    );
  }
  save() {
    this.available();
    if (this.points().length >= 10)
      throw fail('You have 10 restore points. Remove an older one to save another.');
    this.review = null;
    return this.run('saving', () => this.capture());
  }
  run(phase, fn) {
    this.error = '';
    this.phase = phase;
    this.pending = fn()
      .then(() => {
        this.phase = 'done';
      })
      .catch((e) => {
        this.phase = 'error';
        this.error = e.message;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.status();
  }
  async volumeExists(volume) {
    const names = await this.computer.checked([
      'volume',
      'ls',
      '--filter',
      `name=^${volume}$`,
      '--format',
      '{{.Name}}',
    ]);
    return names.trim() === volume;
  }
  async removeVolume(volume) {
    if (volume === this.computer.volume || volume === this.computer.displayVolume)
      throw fail('The current workspace cannot be removed.');
    if (await this.volumeExists(volume)) {
      await this.computer.verifyVolume(volume);
      await this.computer.checked(['volume', 'rm', volume]);
    }
  }
  async cleanHelper(op) {
    const p = this.computer;
    const names = await p.checked([
      'container',
      'ls',
      '-a',
      '--filter',
      `name=^/${op.helper}$`,
      '--format',
      '{{.Names}}',
    ]);
    if (!names.trim()) return;
    const c = JSON.parse(await p.checked(['inspect', op.helper]))[0],
      h = c.HostConfig || {};
    const mounts = c.Mounts || [];
    const backup = ['backup-export', 'backup-import'].includes(op.kind);
    const expectedMounts = backup
      ? [
          {
            name: op.kind === 'backup-export' ? op.source : op.target,
            destination: op.kind === 'backup-export' ? '/source' : '/workspace',
            write: op.kind === 'backup-import',
          },
        ]
      : [
          { name: op.source, destination: '/source', write: false },
          { name: op.target, destination: '/workspace', write: true },
        ];
    if (
      c.Name !== `/${op.helper}` ||
      c.Config?.Labels?.['org.relay.owner'] !== p.owner ||
      c.Config?.Labels?.['org.relay.role'] !== (backup ? 'snapshot-backup' : 'snapshot-copy') ||
      c.Config?.User !== '1000:1000' ||
      h.NetworkMode !== 'none' ||
      !h.ReadonlyRootfs ||
      h.Privileged ||
      h.Binds?.length ||
      !h.CapDrop?.includes('ALL') ||
      !h.SecurityOpt?.some((value) => value.startsWith('no-new-privileges')) ||
      mounts.length !== expectedMounts.length ||
      !expectedMounts.every((expected) =>
        mounts.some(
          (m) =>
            m.Type === 'volume' &&
            m.Name === expected.name &&
            m.Destination === expected.destination &&
            m.RW === expected.write,
        ),
      )
    )
      throw fail('The restore-point helper changed. Ask the server owner to inspect it.');
    await p.checked(['rm', '-f', op.helper]);
  }
  async copy(op) {
    const p = this.computer;
    await p.verifyVolume(op.source);
    if (await this.volumeExists(op.target))
      throw fail('This restore-point destination already exists.');
    await p.checked(['volume', 'create', '--label', `org.relay.owner=${p.owner}`, op.target]);
    op.created = true;
    this.journal(op);
    await p.verifyVolume(op.target);
    try {
      const raw = await p.checked(
        [
          'run',
          '--rm',
          '--name',
          op.helper,
          '--label',
          `org.relay.owner=${p.owner}`,
          '--label',
          'org.relay.role=snapshot-copy',
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '32',
          '--memory',
          '512m',
          '--memory-swap',
          '512m',
          '--cpus',
          '1',
          '--user',
          '1000:1000',
          '--ipc',
          'private',
          '--workdir',
          '/tmp',
          '--mount',
          `type=volume,source=${op.source},target=/source,readonly`,
          '--mount',
          `type=volume,source=${op.target},target=/workspace`,
          '--entrypoint',
          '/usr/bin/python3',
          op.image,
          '-c',
          COPY,
        ],
        { timeout: 300000, maxOutput: 16000 },
      );
      const stats = JSON.parse(raw);
      if (stats.error) throw fail(stats.error);
      if (
        !Number.isSafeInteger(stats.bytes) ||
        stats.bytes < 0 ||
        !Number.isSafeInteger(stats.files) ||
        stats.files < 0
      )
        throw fail('The restore point could not be verified.');
      return stats;
    } finally {
      await this.cleanHelper(op);
    }
  }
  async exclusive(fn) {
    const p = this.computer;
    p.assertAvailable();
    p.maintenance = true;
    p.epoch++;
    p.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    p.network?.stop();
    try {
      await p.cancel().catch(() => {});
      await p.stdio.stopAll();
      return await p.serial(fn);
    } finally {
      p.maintenance = false;
      p.snapshotBlocked = !!this.storedOperation();
    }
  }
  operation(kind, source, target) {
    return {
      kind,
      source,
      target,
      helper: `${this.computer.name}-snapshot-${id()}`,
      image: this.computer.image,
    };
  }
  async thaw(op) {
    if (!op.paused) return;
    const p = this.computer,
      c = await p.inspect();
    if (c?.Id !== op.desktop)
      throw fail('The computer changed while saving. Ask the server owner to inspect it.');
    if (c.State.Paused) await p.checked(['unpause', p.name]);
    if ((await p.inspect())?.State.Paused)
      throw fail('The computer is still paused. Retry the interrupted operation.');
  }
  async capture() {
    return this.exclusive(async () => {
      const p = this.computer,
        c = await p.inspect();
      await p.runtime.inspect();
      if (!(await this.volumeExists(p.volume)))
        throw fail('Start the computer once before saving its first restore point.');
      await p.verifyVolume();
      if (c?.State.Paused)
        throw fail(
          'The computer was paused outside Relay. Resume it before saving a restore point.',
        );
      const pointId = id(),
        op = this.operation('save', p.volume, `${p.name}-snapshot-${pointId}`);
      op.desktop = c?.Id;
      op.paused = !!c?.State.Running;
      this.journal(op);
      try {
        await p.runtime.pause();
        if (op.paused) {
          await p.checked(['pause', p.name]);
          if (!(await p.inspect())?.State.Paused)
            throw fail('The desktop could not be paused to save a consistent restore point.');
        }
        const stats = await this.copy(op);
        this.db
          .prepare('INSERT INTO computer_snapshots VALUES (?,?,?,?,?,?)')
          .run(
            pointId,
            op.target,
            new Date().toISOString(),
            'Saved restore point',
            stats.bytes,
            stats.files,
          );
        return pointId;
      } finally {
        await this.finish(op);
      }
    });
  }
  async finish(op) {
    await this.cleanHelper(op);
    await this.thaw(op);
    const used = this.db
      .prepare('SELECT 1 FROM computer_snapshots WHERE volume=?')
      .get(op.target || null);
    if (op.created && !used && op.target !== this.computer.volume)
      await this.removeVolume(op.target);
    if (op.kind === 'fresh' && op.target === this.computer.volume)
      this.db
        .prepare('INSERT OR IGNORE INTO computer_workspace_losses VALUES (?,?,?)')
        .run(op.target, op.source, new Date().toISOString());
    this.db.prepare('DELETE FROM computer_snapshot_operation WHERE id=1').run();
  }
  switchVolume(volume, previousPoint) {
    const p = this.computer;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (previousPoint)
        this.db
          .prepare('INSERT INTO computer_snapshots VALUES (?,?,?,?,NULL,NULL)')
          .run(previousPoint, p.volume, new Date().toISOString(), 'Before restore');
      this.db.prepare('UPDATE computer_workspace SET volume=? WHERE id=1').run(volume);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    p.volume = volume;
  }
  async restore(point) {
    return this.exclusive(async () => {
      const p = this.computer,
        c = await p.inspect();
      await p.runtime.inspect();
      const hasPrevious = await this.volumeExists(p.volume);
      if (hasPrevious) await p.verifyVolume();
      else if (c || (await p.runtime.inspect()))
        throw fail(
          'The computer still has attached processes. Ask the server owner to inspect it before recovery.',
        );
      await p.verifyVolume(point.volume);
      if (point.volume === p.volume) throw fail('This restore point is the current workspace.');
      const previous = p.volume,
        previousPoint = hasPrevious ? id() : null;
      const op = this.operation('restore', point.volume, `${p.name}-restore-${id()}`);
      this.journal(op);
      try {
        await this.copy(op);
        await p.runtime.stop();
        p.jobs.stopped();
        if (c?.State.Running) await p.checked(['stop', '--time', '3', p.name]);
        if (c) await p.checked(['rm', p.name]);
        p.readyBoot = null;
        this.switchVolume(op.target, previousPoint);
        try {
          await p.startUnlocked('owner');
        } catch (e) {
          const replacement = await p.inspect();
          await p.runtime.stop();
          if (replacement?.State.Running) await p.checked(['stop', '--time', '3', p.name]);
          if (replacement) await p.checked(['rm', p.name]);
          // The old workspace was only detached, never overwritten.
          this.db.exec('BEGIN IMMEDIATE');
          try {
            this.db.prepare('UPDATE computer_workspace SET volume=? WHERE id=1').run(previous);
            this.db.prepare('DELETE FROM computer_snapshots WHERE id=?').run(previousPoint);
            this.db.exec('COMMIT');
          } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
          }
          p.volume = previous;
          p.readyBoot = null;
          if (!hasPrevious)
            throw fail(
              'The imported computer could not start. Your backup is kept; check the computer software before restoring again.',
            );
          await p.startUnlocked('owner');
          throw fail(
            'The restored computer could not start. Your previous workspace is back in place.',
          );
        }
      } finally {
        await this.finish(op);
      }
    });
  }
  async startFresh() {
    return this.exclusive(async () => {
      await this.assertMissingWorkspace();
      const p = this.computer,
        previous = p.volume;
      const op = this.operation('fresh', previous, `${p.name}-restore-${id()}`);
      this.journal(op);
      try {
        if (await this.volumeExists(op.target))
          throw fail('The new workspace destination already exists.');
        op.created = true;
        this.journal(op);
        await p.checked(['volume', 'create', '--label', `org.relay.owner=${p.owner}`, op.target]);
        await p.verifyVolume(op.target);
        p.jobs.stopped();
        p.readyBoot = null;
        this.switchVolume(op.target, null);
        try {
          await p.startUnlocked('owner');
        } catch (error) {
          const replacement = await p.inspect();
          await p.runtime.stop();
          if (replacement?.State.Running) await p.checked(['stop', '--time', '3', p.name]);
          if (replacement) await p.checked(['rm', p.name]);
          this.db.prepare('UPDATE computer_workspace SET volume=? WHERE id=1').run(previous);
          p.volume = previous;
          p.readyBoot = null;
          throw fail(
            'The new computer could not start. The previous workspace location is unchanged. Check the computer software, then try again.',
          );
        }
      } finally {
        await this.finish(op);
      }
    });
  }
  async remove(point) {
    await this.removeVolume(point.volume);
    this.db.prepare('DELETE FROM computer_snapshots WHERE id=?').run(point.id);
  }
  async reconcile() {
    const op = this.storedOperation();
    if (!op) return this.status();
    if (this.pending) throw fail('Wait for the current restore-point operation.');
    this.computer.snapshotBlocked = false;
    this.run('recovering', () => this.exclusive(() => this.finish(op)));
    await this.pending;
    if (this.phase === 'done') {
      this.phase = 'error';
      this.error =
        'A restore-point operation was interrupted. Saved points and the current workspace are kept. Check the computer before continuing.';
    }
    return this.status();
  }
  async close() {
    await this.downloads?.close();
    await this.pending;
  }
}
