#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Bounded background jobs inside Relay's command container, never on the host."""
import json
import errno
import fcntl
import hashlib
import os
import re
import selectors
import signal
import socket
import struct
import subprocess
import sys
import time
import termios
from pathlib import Path

ROOT = Path('/tmp/relay-background')
TAIL = 64000
ACTIVE = {'starting', 'running'}


def input_request(p):
    operation = p.get('inputId', '')
    data = p.get('data')
    if not re.fullmatch('[a-f0-9]{64}', operation) or not isinstance(data, str):
        raise ValueError('Invalid terminal input.')
    encoded = data.encode('utf8')
    if not encoded or len(encoded) > 4096:
        raise ValueError('Send from one to 4,096 bytes at a time.')
    return operation, encoded, hashlib.sha256(encoded).hexdigest()


def input_receipt(d, operation, digest):
    try:
        receipts = read(d / 'inputs.json')
    except FileNotFoundError:
        receipts = {}
    previous = receipts.get(operation)
    if previous:
        if previous['hash'] != digest:
            raise ValueError('That input operation belongs to different text.')
        if previous['status'] != 'accepted':
            raise ValueError('The input outcome is uncertain. Inspect the program before sending anything else; this input will not be replayed.')
        return receipts, {'accepted': True, 'bytes': previous['bytes'], 'repeated': True}
    return receipts, None


def send_input(p):
    d = folder(p.get('id'))
    operation, _, digest = input_request(p)
    _, previous = input_receipt(d, operation, digest)
    if previous:
        return {'id': p['id'], 'inputId': operation, **previous}
    state = status(p['id'])
    if state['status'] != 'running' or not state.get('pty'):
        raise ValueError('This interactive job is not accepting input.')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(3)
        client.connect(str(d / 'input.sock'))
        client.sendall(json.dumps(p).encode('utf8') + b'\n')
        raw = bytearray()
        while b'\n' not in raw and len(raw) <= 4000:
            chunk = client.recv(4001)
            if not chunk:
                break
            raw.extend(chunk)
        result = json.loads(raw)
        if result.get('error'):
            raise ValueError(result['error'])
        return result


def accept_input(listener, master, d, job, child):
    connection, _ = listener.accept()
    with connection:
        connection.settimeout(.3)
        try:
            raw = bytearray()
            while b'\n' not in raw and len(raw) <= 26000:
                chunk = connection.recv(26001)
                if not chunk:
                    break
                raw.extend(chunk)
            if len(raw) > 26000:
                raise ValueError('Terminal input is too large.')
            p = json.loads(raw)
            operation, data, digest = input_request(p)
            if p.get('id') != job:
                raise ValueError('Wrong terminal session.')
            receipts, previous = input_receipt(d, operation, digest)
            if not previous:
                if child.poll() is not None:
                    raise ValueError('This interactive job has finished.')
                if len(receipts) >= 256:
                    raise ValueError('This session reached its 256-input limit.')
                # Persist intent before writing. A crash or lost response never
                # authorizes replay of keystrokes that may already have acted.
                receipts[operation] = {'hash': digest, 'status': 'uncertain'}
                save(d / 'inputs.json', receipts)
                count = os.write(master, data)
                if count != len(data):
                    raise ValueError('Only part of the input was accepted. Inspect the program; this input will not be replayed.')
                receipts[operation].update(status='accepted', bytes=count)
                save(d / 'inputs.json', receipts)
                previous = {'accepted': True, 'bytes': count, 'repeated': False}
            response = {'id': job, 'inputId': operation, **previous}
        except Exception as error:
            response = {'error': str(error)[:500]}
        try:
            connection.sendall(json.dumps(response).encode('utf8') + b'\n')
        except OSError:
            pass


def folder(job):
    if not isinstance(job, str) or not re.fullmatch('[a-f0-9]{32}', job):
        raise ValueError('Invalid computer job.')
    return ROOT / job


def save(path, data):
    temporary = path.with_suffix('.next')
    temporary.write_text(json.dumps(data))
    temporary.replace(path)


def read(path):
    with path.open('rb') as f:
        raw = f.read(400001)
    if len(raw) > 400000:
        raise ValueError('Job state exceeds its size limit.')
    return json.loads(raw)


def alive(pid, started, job):
    try:
        stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        return stat[0] != 'Z' and stat[19] == started and args[1:4] == [b'/opt/relay/jobs.py', b'serve', job.encode()]
    except (OSError, IndexError):
        return False


def status(job):
    d = folder(job)
    try:
        state = read(d / 'state.json')
    except FileNotFoundError:
        return {'id': job, 'status': 'missing'}
    if state['status'] in ACTIVE and not alive(state['pid'], state['started'], job):
        state.update(status='interrupted', error='The job process ended without a confirmed result.')
        save(d / 'state.json', state)
    return state


def stop(job):
    # Works in a short-lived helper sharing only the command PID namespace.
    # PID 1's root locates its private tmpfs while the runtime is frozen.
    global ROOT
    if not ROOT.exists():
        ROOT = Path('/proc/1/root/tmp/relay-background')
    state = status(job)
    if state['status'] not in ACTIVE:
        return state
    if alive(state['pid'], state['started'], job):
        try:
            os.killpg(state['pid'], signal.SIGKILL)
        except ProcessLookupError:
            pass
    state.update(status='cancelled', finishedAt=time.time(), exitCode=None)
    save(folder(job) / 'state.json', state)
    return state


def start(p):
    job = p.get('id')
    d = folder(job)
    command = p.get('command', '')
    seconds = p.get('seconds', 3600)
    if not isinstance(p.get('pty', False), bool):
        raise ValueError('Interactive mode must be true or false.')
    if not isinstance(command, str) or not command.strip() or len(command) > 8000:
        raise ValueError('Use a command of at most 8,000 characters.')
    if not isinstance(seconds, int) or not 1 <= seconds <= 86400:
        raise ValueError('Choose a time limit from one second to one day.')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    try:
        d.mkdir(mode=0o700)
    except FileExistsError:
        # Never relaunch after a lost acknowledgement.
        return status(job)
    save(d / 'request.json', p)
    child = subprocess.Popen(['/usr/bin/python3', '/opt/relay/jobs.py', 'serve', job],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
    started = Path(f'/proc/{child.pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    save(d / 'state.json', {'id': job, 'pid': child.pid, 'started': started, 'status': 'starting',
                          'pty': p.get('pty', False), 'stdout': '', 'stderr': '', 'truncated': False, 'exitCode': None})
    # Publish identity before allowing the supervisor to execute. A delayed
    # Python startup can never look like a missing job that starts later.
    save(d / 'launch.json', {'ready': True})
    return status(job)


def serve(job):
    d = folder(job)
    deadline = time.monotonic() + 30
    while not (d / 'launch.json').exists():
        if time.monotonic() >= deadline:
            return
        time.sleep(.02)
    from guest import parent
    p = read(d / 'request.json')
    state = {'id': job, 'pid': os.getpid(), 'started': Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19],
             'status': 'starting', 'pty': p.get('pty', False), 'stdout': '', 'stderr': '', 'truncated': False, 'exitCode': None}
    save(d / 'state.json', state)
    selector = selectors.DefaultSelector()
    child = None
    master = None
    listener = None
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    start_time = time.monotonic()
    saved_at = 0
    try:
        with parent(p.get('cwd', '.')) as (fd, name):
            cwd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                env = {**os.environ, 'http_proxy': 'http://127.0.0.1:8088', 'https_proxy': 'http://127.0.0.1:8088',
                       'HTTP_PROXY': 'http://127.0.0.1:8088', 'HTTPS_PROXY': 'http://127.0.0.1:8088'}
                if state['pty']:
                    master, slave = os.openpty()
                    os.set_blocking(master, False)
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
                    # The supervisor owns the session and controlling terminal;
                    # normal children stay in its group so frozen cancellation
                    # still stops them without thawing any other job.
                    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                    signal.signal(signal.SIGINT, signal.SIG_IGN)
                    signal.signal(signal.SIGQUIT, signal.SIG_IGN)
                    signal.signal(signal.SIGHUP, signal.SIG_IGN)
                    def child_signals():
                        for sig in (signal.SIGINT, signal.SIGQUIT, signal.SIGHUP):
                            signal.signal(sig, signal.SIG_DFL)
                    try:
                        child = subprocess.Popen(['/bin/bash', '-lc', p['command']], cwd=f'/proc/self/fd/{cwd}',
                                                 pass_fds=(cwd,), stdout=slave, stderr=slave, stdin=slave,
                                                 env={**env, 'TERM': 'dumb', 'COLUMNS': '100', 'LINES': '30'},
                                                 preexec_fn=child_signals)
                    finally:
                        os.close(slave)
                    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    listener.bind(str(d / 'input.sock'))
                    os.chmod(d / 'input.sock', 0o600)
                    listener.listen(4)
                    listener.setblocking(False)
                    selector.register(listener, selectors.EVENT_READ, 'input')
                    selector.register(master, selectors.EVENT_READ, 'stdout')
                else:
                    child = subprocess.Popen(['/bin/bash', '-lc', p['command']], cwd=f'/proc/self/fd/{cwd}',
                                             pass_fds=(cwd,), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                             stdin=subprocess.DEVNULL, env=env)
                    selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
                    selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
            finally:
                os.close(cwd)
        state['status'] = 'running'
        while True:
            for key, _ in selector.select(.05):
                if key.data == 'input':
                    accept_input(listener, master, d, job, child)
                    continue
                try:
                    chunk = os.read(key.fd, 8192)
                except OSError as error:
                    if state['pty'] and error.errno == errno.EIO:
                        chunk = b''
                    else:
                        raise
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    buf = output[key.data]
                    buf.extend(chunk)
                    if len(buf) > TAIL // 2:
                        del buf[:len(buf) - TAIL // 2]
                        state['truncated'] = True
            state.update({key: value.decode('utf8', errors='replace') for key, value in output.items()})
            if time.monotonic() - saved_at >= .25:
                save(d / 'state.json', state)
                saved_at = time.monotonic()
            code = child.poll()
            if code is not None and not selector.select(0):
                state.update(status='completed' if code == 0 else 'failed', exitCode=code)
                break
            if time.monotonic() - start_time >= p.get('seconds', 3600):
                state.update(status='timed_out', exitCode=124)
                break
        state['finishedAt'] = time.time()
    except Exception as error:
        state.update(status='failed', error=str(error)[:500], finishedAt=time.time())
    finally:
        selector.close()
        if listener:
            listener.close()
        if master is not None:
            os.close(master)
        save(d / 'state.json', state)
        # The shell and normal descendants share this supervisor's session.
        # Ending the tracked job ends that process group, including this worker.
        os.killpg(os.getpid(), signal.SIGKILL)


def handle(p):
    if p.get('action') == 'start':
        return start(p)
    if p.get('action') == 'list':
        ids = p.get('ids', [])
        if not isinstance(ids, list) or len(ids) > 8:
            raise ValueError('Inspect at most eight active jobs.')
        return {'jobs': [status(job) for job in ids]}
    if p.get('action') == 'stop':
        return stop(p.get('id'))
    if p.get('action') == 'input':
        return send_input(p)
    if p.get('action') == 'forget':
        import shutil
        for job in p.get('ids', [])[:64]:
            if status(job)['status'] not in ACTIVE:
                shutil.rmtree(folder(job), ignore_errors=True)
        return {'ok': True}
    raise ValueError('Unsupported background job action.')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'serve':
        serve(sys.argv[2])
    else:
        try:
            p = json.loads(sys.stdin.buffer.read(64001))
            print(json.dumps({'result': handle(p)}))
        except Exception as error:
            print(json.dumps({'error': str(error)[:500]}))
            sys.exit(1)
