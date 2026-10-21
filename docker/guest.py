#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Relay guest protocol. One bounded JSON request over stdin, one reply over stdout.

No network listener, host mounts, credentials or third-party assistant code.
"""
import base64
import io
import json
import os
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import PurePosixPath
from PIL import Image

LIMIT = 8_000_000

# Only document apps, never an arbitrary handler, executable, URL or shell.
APPS = [
    {'id': 'writer', 'label': 'Document', 'extensions': ['docx', 'doc', 'odt', 'rtf']},
    {'id': 'calc', 'label': 'Spreadsheet', 'extensions': ['xlsx', 'xls', 'ods', 'csv', 'tsv']},
    {'id': 'impress', 'label': 'Slides', 'extensions': ['pptx', 'ppt', 'odp']},
    {'id': 'draw', 'label': 'PDF', 'extensions': ['pdf', 'odg']},
    {'id': 'text', 'label': 'Text', 'extensions': ['txt', 'md', 'json', 'yaml', 'yml', 'log', 'py', 'js', 'ts', 'css', 'html', 'sh']},
]


def document_app(p):
    path = None
    if p.get('action') == 'new':
        app = next((a for a in APPS if a['id'] == p.get('app') and a['id'] in ['writer', 'calc', 'impress']), None)
    elif p.get('action') == 'open':
        requested = p.get('path')
        with parent(requested) as (fd, name):
            opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                s = os.fstat(opened)
                if not stat.S_ISREG(s.st_mode) or s.st_size > LIMIT:
                    raise ValueError('Choose a regular document of at most 8 MB.')
                # Descriptor-walk validation above refuses symlinks at every level.
                path = '/workspace/' + str(PurePosixPath(requested.removeprefix('/workspace/')))
                ext = PurePosixPath(name).suffix.lower().removeprefix('.')
                app = next((a for a in APPS if ext in a['extensions']), None)
            finally:
                os.close(opened)
    else:
        raise ValueError('Choose a document to open or create.')
    if not app:
        raise ValueError('This file does not have a supported document app. Save it to Relay instead.')
    if app['id'] == 'text':
        command = ['mousepad', '--disable-server', path]
    else:
        if not shutil.which('libreoffice'):
            raise ValueError('Update the computer in Computer care to add document apps.')
        # The owner's app must not forward to a frozen agent-owned office process.
        # Agent commands use LibreOffice's separate default profile.
        command = ['libreoffice', '-env:UserInstallation=file:///workspace/.home/office-owner',
                   '--nologo', '--norestore', path or '--' + app['id']]
    child = subprocess.Popen(command, cwd='/workspace', stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    time.sleep(.25)
    if child.poll() not in [None, 0]:
        raise ValueError('The document app could not start. Check the computer and try again.')
    return {'launched': True, 'app': app['id'], 'path': path}


def xdo(*args):
    return subprocess.run(['xdotool', *map(str, args)], capture_output=True, timeout=5, check=True).stdout.decode().strip()


@contextmanager
def parent(path):
    # Walk directory descriptors without following symlinks, including on the final file.
    if not isinstance(path, str) or len(path) > 1024 or '\0' in path:
        raise ValueError('Choose a path inside /workspace.')
    path = path.removeprefix('/workspace/')
    if path == '/workspace':
        path = '.'
    parts = PurePosixPath(path).parts
    if path.startswith('/') or '..' in parts:
        raise ValueError('Paths must stay inside /workspace.')
    fd = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd, parts[-1] if parts else '.'
    finally:
        os.close(fd)


def files(p):
    op = p['action']
    with parent(p.get('path', '.')) as (fd, name):
        if op == 'mkdir':
            os.mkdir(name, mode=0o700, dir_fd=fd)
            return {'created': True}
        if op == 'write':
            data = base64.b64decode(p['base64'], validate=True)
            if len(data) > LIMIT:
                raise ValueError('Files are limited to 8 MB.')
            flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
            flags |= os.O_TRUNC if p.get('overwrite') is True else os.O_EXCL
            out = os.open(name, flags, 0o600, dir_fd=fd)
            with os.fdopen(out, 'wb') as f:
                if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                    raise ValueError('Choose a regular file.')
                f.write(data)
            return {'path': p['path'], 'size': len(data)}
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if op == 'list':
            flags |= os.O_DIRECTORY
        opened = os.open(name, flags, dir_fd=fd)
        try:
            if op == 'list':
                names = sorted(os.listdir(opened))
                entries = []
                for child in names[:300]:
                    s = os.stat(child, dir_fd=opened, follow_symlinks=False)
                    entries.append({'name': child, 'kind': 'directory' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'link', 'size': s.st_size})
                return {'path': p.get('path', '.'), 'entries': entries, 'truncated': len(names) > 300}
            s = os.fstat(opened)
            if not stat.S_ISREG(s.st_mode) or s.st_size > LIMIT:
                raise ValueError('Choose a regular file of at most 8 MB.')
            with os.fdopen(os.dup(opened), 'rb') as f:
                data = f.read(LIMIT + 1)
            if len(data) > LIMIT:
                raise ValueError('Files are limited to 8 MB.')
            return {'name': name, 'size': len(data), 'base64': base64.b64encode(data).decode()}
        finally:
            os.close(opened)


def is_terminal():
    try:
        window = xdo('getwindowfocus')
        value = subprocess.run(['xprop', '-id', window, 'WM_CLASS'], capture_output=True,
                               timeout=2, check=True).stdout.decode()
        return bool(re.search(r'"(?:xterm|uxterm|XTerm|UXTerm|Xfce4-terminal|Gnome-terminal|kitty|Alacritty)"', value))
    except Exception:
        return False


def shot(controls=False):
    raw = subprocess.run(['scrot', '-z', '-'], capture_output=True, timeout=5, check=True).stdout
    output = io.BytesIO()
    Image.open(io.BytesIO(raw)).convert('RGB').save(output, format='JPEG', quality=72)
    try:
        title = xdo('getwindowfocus', 'getwindowname')
    except Exception:
        title = 'Relay desktop'
    result = {'width': 1280, 'height': 800, 'mime': 'image/jpeg', 'screenshot': base64.b64encode(output.getvalue()).decode(), 'title': title[:200], 'terminal': is_terminal()}
    if controls:
        try:
            observed = subprocess.run(['/usr/bin/python3', '/opt/relay/accessibility.py'],
                                      capture_output=True, timeout=1.8, check=True).stdout
            if len(observed) > 32768:
                raise ValueError('Observation too large.')
            result['accessibility'] = json.loads(observed)
        except Exception:
            result['accessibility'] = {'available': False, 'reason': 'Controls unavailable. Use the screenshot.'}
    return result


def paste_text(text):
    # X11's synthetic Unicode keymap remapping can lose adjacent characters.
    # Serve UTF-8 from a temporary guest-only selection while the app pastes it.
    # Never read or synchronize the owner's host clipboard.
    import tkinter as tk
    root = tk.Tk()
    root.withdraw()
    process = None
    try:
        root.clipboard_clear()
        root.clipboard_append(text)
        root.update()
        process = subprocess.Popen(['xdotool', 'key', '--clearmodifiers', 'ctrl+v'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            root.update()
            time.sleep(0.01)
        if process.wait(timeout=2):
            raise ValueError('Text input failed. Inspect the application before retrying.')
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        root.destroy()


def desktop(p):
    action = p['action']
    if action == 'open_url':
        from urllib.parse import urlsplit
        url = p.get('url', '')
        parsed = urlsplit(url)
        if len(url) > 3000 or parsed.scheme not in ('http', 'https') or parsed.username or parsed.password:
            raise ValueError('Use a public HTTP or HTTPS website.')
        subprocess.run(['chromium', '--no-sandbox', '--user-data-dir=' + os.environ['HOME'] + '/chromium', '--new-window', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8, check=True)
        time.sleep(0.4)
        return shot(p.get('controls') is True)
    if action in ('click', 'double_click', 'right_click', 'move', 'scroll', 'drag'):
        x, y = p.get('x', 640), p.get('y', 400)
        if not all(type(v) in (int, float) and 0 <= v < limit for v, limit in ((x, 1280), (y, 800))):
            raise ValueError('Choose coordinates inside the screen.')
        if action == 'drag':
            to_x, to_y = p.get('toX'), p.get('toY')
            if not all(type(v) in (int, float) and 0 <= v < limit for v, limit in ((to_x, 1280), (to_y, 800))):
                raise ValueError('Choose drag endpoints inside the screen.')
        # --sync waits for movement and hangs when the pointer is already here.
        xdo('mousemove', round(x), round(y))
    if action in ('click', 'double_click', 'right_click'):
        xdo('click', '--repeat', 2 if action == 'double_click' else 1, '--delay', 100, 3 if action == 'right_click' else 1)
    elif action == 'drag':
        # One bounded gesture, with release even on cancellation or failed movement.
        # Validate both endpoints before touching the desktop.
        marker = '/tmp/relay-jobs/' + p.get('job', '') + '.cancel'
        try:
            xdo('mousedown', 1)
            for step in range(1, 17):
                if p.get('job') and os.path.exists(marker):
                    raise ValueError('Drag was stopped. Inspect the screen before trying again.')
                xdo('mousemove', round(x + (to_x - x) * step / 16), round(y + (to_y - y) * step / 16))
                time.sleep(0.018)
        finally:
            xdo('mouseup', 1)
    elif action == 'type':
        text = p.get('text', '')
        if not isinstance(text, str) or len(text) > 4000:
            raise ValueError('Type at most 4,000 characters.')
        if not text.isascii() or len(text) > 200:
            paste_text(text)
        else:
            xdo('type', '--clearmodifiers', '--delay', 1, '--', text)
    elif action == 'key':
        key = p.get('key', '')
        if not re.fullmatch(r'(?:(?:ctrl|alt|shift|super)\+){0,3}(?:[a-zA-Z0-9]|Return|Tab|Escape|BackSpace|Delete|Left|Right|Up|Down|Home|End|Prior|Next|space|F[1-9]|F1[0-2])', key):
            raise ValueError('Unsupported key.')
        xdo('key', '--clearmodifiers', key)
    elif action == 'scroll':
        xdo('click', '--repeat', 4, 4 if p.get('direction') == 'up' else 5)
    elif action not in ('screenshot', 'move'):
        raise ValueError('Unsupported desktop action.')
    if action != 'screenshot':
        time.sleep(0.12)
    return shot(p.get('controls') is True)


def clipboard(p):
    action = p.get('action')
    if action not in ('copy', 'cut'):
        raise ValueError('Choose Copy or Cut.')
    # Copy first: a size/type failure must not remove selected text. This is
    # guest-only X11 data, requested explicitly by the owner, never a host read.
    terminal = is_terminal()
    if terminal and action == 'cut':
        raise ValueError('Terminal selections can be copied, but not cut.')
    if not terminal:
        xdo('key', '--clearmodifiers', 'ctrl+c')
        time.sleep(0.15)
    # Xterm owns PRIMARY for selected text. Never send Ctrl-C to copy from a shell.
    process = subprocess.Popen(['xclip', '-selection', 'primary' if terminal else 'clipboard', '-out', '-target', 'UTF8_STRING'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    value = bytearray()
    deadline = time.monotonic() + 3
    try:
        while selector.get_map():
            if time.monotonic() > deadline:
                raise ValueError('The computer clipboard did not respond. Select text and try Copy again.')
            for key, _ in selector.select(0.1):
                data = os.read(key.fileobj.fileno(), 8192)
                if not data:
                    selector.unregister(key.fileobj)
                else:
                    value.extend(data)
                    if len(value) > 65536:
                        raise ValueError('Copy up to 64 KB of plain text at a time. The selection was not cut.')
        if process.wait(timeout=1) or not value:
            raise ValueError('Select text in the computer first. Only plain text can be copied.')
        try:
            text = value.decode('utf-8')
        except UnicodeDecodeError:
            raise ValueError('Only UTF-8 plain text can be copied.')
        if '\0' in text:
            raise ValueError('Only plain text can be copied.')
        if action == 'cut':
            xdo('key', '--clearmodifiers', 'ctrl+x')
        return {'text': text}
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()


def run_command(p):
    command = p.get('command', '')
    if not isinstance(command, str) or not command.strip() or len(command) > 8000:
        raise ValueError('Use a command of at most 8,000 characters.')
    job = p['job']
    if not re.fullmatch('[a-f0-9]{32}', job):
        raise ValueError('Invalid job.')
    marker = '/tmp/relay-jobs/' + job
    os.makedirs('/tmp/relay-jobs', mode=0o700, exist_ok=True)
    cancelled = marker + '.cancel'
    timeout = min(60, max(1, int(p.get('seconds', 30))))
    with parent(p.get('cwd', '.')) as (fd, name):
        cwd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            env = {**os.environ, 'http_proxy': 'http://127.0.0.1:8088', 'https_proxy': 'http://127.0.0.1:8088', 'HTTP_PROXY': 'http://127.0.0.1:8088', 'HTTPS_PROXY': 'http://127.0.0.1:8088'}
            child = subprocess.Popen(['/bin/bash', '-lc', command], cwd=f'/proc/self/fd/{cwd}', pass_fds=(cwd,), stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, stdin=subprocess.DEVNULL, env=env)
        finally:
            os.close(cwd)
    def terminate():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    with open(marker, 'w') as f:
        f.write(str(child.pid))
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    start = time.monotonic()
    truncated = False
    timed_out = False
    try:
        while selector.get_map():
            if os.path.exists(cancelled):
                terminate()
                break
            if time.monotonic() - start > timeout:
                timed_out = True
                terminate()
                break
            for key, _ in selector.select(0.05):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                available = max(0, 128000 - sum(map(len, output.values())))
                output[key.data].extend(chunk[:available])
                if len(chunk) > available:
                    truncated = True
                    terminate()
                    break
            if truncated:
                break
            if child.poll() is not None and not selector.select(0):
                # Do not wait for detached apps that inherited stdout.
                break
        if child.poll() is None and not (truncated or timed_out):
            child.wait(timeout=max(.1, timeout - (time.monotonic() - start)))
        return {**{k: v.decode('utf8', errors='replace') for k, v in output.items()}, 'exitCode': 124 if timed_out else child.wait(), 'timedOut': timed_out, 'truncated': truncated}
    finally:
        selector.close()
        child.stdout.close()
        child.stderr.close()
        if child.poll() is None:
            terminate()
        try:
            os.unlink(marker)
        except FileNotFoundError:
            pass
        try:
            os.unlink(cancelled)
        except FileNotFoundError:
            pass


def main(p):
    if p.get('kind') == 'health':
        # Written once per boot after the welcome window appears; closing the
        # welcome window later should not make a working desktop unhealthy.
        return {'ready': os.path.isfile('/tmp/relay-desktop-ready'),
                'apps': APPS if shutil.which('libreoffice') else []}
    if p.get('kind') == 'app':
        return document_app(p)
    if p.get('kind') == 'files':
        return files(p)
    if p.get('kind') == 'desktop':
        return desktop(p)
    if p.get('kind') == 'clipboard':
        return clipboard(p)
    if p.get('kind') == 'jobs':
        from jobs import handle
        return handle(p)
    if p.get('kind') == 'exec':
        return run_command(p)
    if p.get('kind') == 'cancel':
        if not re.fullmatch('[a-f0-9]{32}', p.get('job', '')):
            raise ValueError('Invalid job.')
        with open('/tmp/relay-jobs/' + p['job'] + '.cancel', 'w'):
            pass
        try:
            with open('/tmp/relay-jobs/' + p['job']) as f:
                os.killpg(int(f.read()), signal.SIGKILL)
        except (FileNotFoundError, ProcessLookupError):
            pass
        return {'cancelled': True}
    raise ValueError('Unsupported computer request.')


if __name__ == '__main__':
    try:
        request = sys.stdin.buffer.read(12_000_001)
        if len(request) > 12_000_000:
            raise ValueError('Request too large.')
        print(json.dumps({'result': main(json.loads(request))}))
    except Exception as error:
        print(json.dumps({'error': str(error)[:500]}))
        sys.exit(1)
