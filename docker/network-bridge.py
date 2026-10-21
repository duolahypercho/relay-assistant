#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Loopback HTTP proxy; all egress is decided and opened by Relay outside this guest."""
import base64, json, queue, socket, socketserver, sys, threading, uuid
from urllib.parse import urlsplit

clients = {}
lock = threading.Lock()
output_lock = threading.Lock()
slots = threading.BoundedSemaphore(32)

def emit(frame):
    with output_lock:
        sys.stdout.write(json.dumps(frame, separators=(',', ':')) + '\n')
        sys.stdout.flush()

class Proxy(socketserver.BaseRequestHandler):
    def handle(self):
        if not slots.acquire(blocking=False):
            return
        ident = uuid.uuid4().hex
        incoming = queue.Queue(maxsize=32)
        with lock:
            clients[ident] = incoming
        self.request.settimeout(35)
        try:
            data = b''
            while b'\r\n\r\n' not in data:
                chunk = self.request.recv(4096)
                if not chunk or len(data) + len(chunk) > 16384:
                    return
                data += chunk
            head, rest = data.split(b'\r\n\r\n', 1)
            first, *headers = head.split(b'\r\n')
            method, target, version = first.decode('ascii').split(' ')
            if version not in ('HTTP/1.0', 'HTTP/1.1'):
                return
            tunnel = method == 'CONNECT'
            parsed = urlsplit('https://' + target if tunnel else target)
            if parsed.username or parsed.password or parsed.scheme not in ('http', 'https'):
                return
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == 'https' else 80)
            if not host or (tunnel and port != 443) or (not tunnel and (parsed.scheme != 'http' or port != 80)):
                return
            emit({'type': 'open', 'id': ident, 'host': host, 'port': port})
            answer = incoming.get(timeout=15)
            if answer.get('type') != 'opened':
                body = str(answer.get('error', 'Website access is unavailable.')).encode()[:1000]
                self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
                return
            if tunnel:
                self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                initial = rest
            else:
                # Use the authority approved by Relay, never an independent Host header.
                path = (parsed.path or '/') + ('?' + parsed.query if parsed.query else '')
                kept = [h for h in headers if h.split(b':',1)[0].lower() not in (b'host',b'proxy-authorization',b'proxy-connection')]
                initial = method.encode() + b' ' + path.encode('ascii') + b' ' + version.encode() + b'\r\nHost: ' + host.encode('ascii') + b'\r\n' + b'\r\n'.join(kept) + b'\r\n\r\n' + rest
            if initial:
                emit({'type': 'data', 'id': ident, 'data': base64.b64encode(initial).decode()})
            def receive():
                try:
                    while True:
                        frame = incoming.get(timeout=40)
                        if frame.get('type') != 'data':
                            break
                        raw = base64.b64decode(frame['data'], validate=True)
                        if len(raw) > 48000:
                            break
                        self.request.sendall(raw)
                except Exception:
                    pass
                finally:
                    try: self.request.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
            thread = threading.Thread(target=receive, daemon=True)
            thread.start()
            while True:
                chunk = self.request.recv(48000)
                if not chunk:
                    break
                emit({'type': 'data', 'id': ident, 'data': base64.b64encode(chunk).decode()})
        except Exception:
            pass
        finally:
            with lock:
                clients.pop(ident, None)
            try: incoming.put_nowait({'type':'close'})
            except queue.Full: pass
            emit({'type':'close','id':ident})
            slots.release()

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 32

server = Server(('127.0.0.1',8088), Proxy)
threading.Thread(target=server.serve_forever, daemon=True).start()
emit({'type':'ready'})
try:
    for line in sys.stdin:
        if len(line) > 90000:
            break
        frame = json.loads(line)
        with lock:
            destination = clients.get(frame.get('id'))
        if destination:
            try: destination.put_nowait(frame)
            except queue.Full:
                while not destination.empty(): destination.get_nowait()
                destination.put_nowait({'type':'close'})
finally:
    server.shutdown()
    server.server_close()
