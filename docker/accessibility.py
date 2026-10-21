#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Bounded, read-only AT-SPI hints for the focused guest window.

No text/value, action, editable-text or input APIs are used. These observations
supplement the screen; toolkit SHOWING flags do not establish visual occlusion.
"""
import json
import math
import os
import re
import subprocess
import time

ROLES = {
    'push button', 'button', 'toggle button', 'check box', 'radio button',
    'entry', 'text', 'password text', 'password entry', 'combo box', 'list box',
    'list item', 'menu', 'menu item', 'check menu item', 'radio menu item',
    'page tab', 'link', 'slider', 'spin button', 'heading', 'label', 'static',
}
LIMIT = 80


def point(rect):
    if len(rect) != 4 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in rect):
        return None
    x, y, width, height = rect
    if width <= 0 or height <= 0:
        return None
    left, top, right, bottom = max(0, x), max(0, y), min(1280, x + width), min(800, y + height)
    if right <= left or bottom <= top:
        return None
    # Both axes deliberately use the same 0–1000 convention supported by
    # computer_use, including on connections whose default is pixels.
    return {'x': round((left + right) / 2 / 1280 * 1000),
            'y': round((top + bottom) / 2 / 800 * 1000)}


def label(value):
    return re.sub(r'[\x00-\x1f\x7f]', ' ', str(value or ''))[:180].strip()


def collect(root, pid, api, clock=time.monotonic):
    deadline = clock() + 1.0
    windows = []
    for index in range(min(root.childCount, 32)):
        if clock() > deadline:
            break
        try:
            app = root[index]
            if app.get_process_id() != pid:
                continue
            for window_index in range(min(app.childCount, 32)):
                if clock() > deadline:
                    break
                window = app[window_index]
                states = window.getState()
                if states.contains(api.STATE_ACTIVE) and states.contains(api.STATE_SHOWING):
                    windows.append(window)
        except Exception:
            continue
    if len(windows) != 1:
        return {'available': False, 'reason': 'No unambiguous focused app controls.'}
    controls, seen = [], set()
    visited, size, truncated = 0, 0, False

    def walk(node, depth=0):
        nonlocal visited, size, truncated
        if clock() > deadline or visited >= 500 or len(controls) >= LIMIT or depth > 24:
            truncated = True
            return
        identity = hash(node)
        if identity in seen:
            return
        seen.add(identity)
        visited += 1
        try:
            states = node.getState()
            if not states.contains(api.STATE_SHOWING):
                return
            role = node.getRoleName()
            protected = role in ('password text', 'password entry')
            if role in ROLES:
                try:
                    location = point(list(node.queryComponent().getExtents(api.DESKTOP_COORDS)))
                except Exception:
                    location = None
                if location:
                    name = 'Password field' if protected else label(node.name)
                    control = {'role': role, 'name': name, **location}
                    if protected:
                        control['protected'] = True
                    if states.contains(api.STATE_FOCUSED):
                        control['focused'] = True
                    if not states.contains(api.STATE_ENABLED):
                        control['enabled'] = False
                    if role in ('check box', 'radio button', 'toggle button', 'check menu item', 'radio menu item'):
                        control['checked'] = states.contains(api.STATE_CHECKED)
                    length = len(json.dumps(control, ensure_ascii=False).encode('utf-8'))
                    if size + length > 24000:
                        truncated = True
                        return
                    controls.append(control)
                    size += length
            # A password widget can expose internal text children. Never inspect
            # them, including when the widget has no usable bounds of its own.
            if protected:
                return
            count = min(node.childCount, 500)
            if node.childCount > count:
                truncated = True
            for index in range(count):
                if clock() > deadline or visited >= 500 or len(controls) >= LIMIT:
                    truncated = True
                    break
                walk(node[index], depth + 1)
        except Exception:
            # One disappearing or unsupported widget must not discard the
            # rest of an otherwise useful observation.
            return

    walk(windows[0])
    return {'available': True, 'coordinateSpace': 'normalized_1000',
            'controls': controls, 'truncated': truncated, 'sourceData': True}


def focus():
    value = subprocess.run(['xdotool', 'getwindowfocus'], capture_output=True,
                           timeout=.25, check=True).stdout.decode().strip()
    if not value.isdecimal():
        raise ValueError('Invalid focused window.')
    return value


def capture():
    os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/tmp/relay-runtime/bus'
    import pyatspi
    window = focus()
    pid = int(subprocess.run(['xdotool', 'getwindowpid', window], capture_output=True,
                             timeout=.25, check=True).stdout.decode().strip())
    result = collect(pyatspi.Registry.getDesktop(0), pid, pyatspi)
    if focus() != window:
        return {'available': False, 'reason': 'Focus changed. Inspect the screen again.'}
    return result


if __name__ == '__main__':
    try:
        result = capture()
    except Exception:
        result = {'available': False, 'reason': 'This app does not expose controls. Use the screenshot.'}
    print(json.dumps(result, ensure_ascii=False))
