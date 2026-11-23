#!/usr/bin/env python3
"""Minimal Chrome DevTools Protocol client (stdlib only).

Development tool for verifying the launcher in a real browser: the embedded
preview browser in this chat refuses pointer lock ("WrongDocumentError"), a
separate Chromium window does not.

    python3 dev/cdp.py <port> <url>          # open url, print page title
    from cdp import CDP; CDP(port).eval('1+1')
"""
import base64
import json
import os
import socket
import struct
import sys
import time
import urllib.request


class WS:
    def __init__(self, url):
        assert url.startswith('ws://'), url
        rest = url[5:]
        hostport, path = rest.split('/', 1)
        path = '/' + path
        host, port = hostport.split(':')
        self.sock = socket.create_connection((host, int(port)), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f'GET {path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n'
            f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'
        )
        self.sock.sendall(req.encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError('websocket handshake closed')
            buf += chunk
        if b'101' not in buf.split(b'\r\n')[0]:
            raise RuntimeError('websocket handshake failed: ' + buf[:200].decode('latin1'))
        self.buf = buf.split(b'\r\n\r\n', 1)[1]

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError('socket closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        data = text.encode()
        header = b'\x81'
        n = len(data)
        mask = os.urandom(4)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            header += bytes([0x80 | 127]) + struct.pack('>Q', n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(header + mask + masked)

    def recv(self):
        b1, b2 = self._recv_exact(2)
        opcode = b1 & 0x0F
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack('>H', self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack('>Q', self._recv_exact(8))[0]
        payload = self._recv_exact(length)
        if opcode == 8:
            raise RuntimeError('websocket closed by peer')
        if opcode == 9:  # ping
            self.sock.sendall(b'\x8a' + bytes([0x80 | len(payload)]) + os.urandom(4) +
                              bytes(b ^ 0 for b in payload))
            return self.recv()
        return payload.decode(errors='replace')


class CDP:
    def __init__(self, port, page_index=0):
        tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list'))
        pages = [t for t in tabs if t.get('type') == 'page']
        self.ws = WS(pages[page_index]['webSocketDebuggerUrl'])
        self.next_id = 0
        self.events = []

    def call(self, method, params=None, timeout=120):
        self.next_id += 1
        mid = self.next_id
        self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError(method + ': ' + json.dumps(msg['error']))
                return msg.get('result', {})
            if 'method' in msg:
                self.events.append(msg)
        raise TimeoutError(method)

    def eval(self, expression, await_promise=False):
        r = self.call('Runtime.evaluate', {
            'expression': expression,
            'returnByValue': True,
            'awaitPromise': await_promise,
            'userGesture': True,
        })
        if 'exceptionDetails' in r:
            ex = r['exceptionDetails']
            desc = ex.get('exception', {}).get('description') or ex.get('text')
            raise RuntimeError('page exception: ' + str(desc))
        return r.get('result', {}).get('value')

    def navigate(self, url, settle=2.0):
        self.call('Page.enable')
        self.call('Page.navigate', {'url': url})
        time.sleep(settle)

    def click(self, x, y):
        for kind in ('mousePressed', 'mouseReleased'):
            self.call('Input.dispatchMouseEvent', {
                'type': kind, 'x': x, 'y': y, 'button': 'left', 'buttons': 1,
                'clickCount': 1, 'pointerType': 'mouse',
            })
            time.sleep(0.05)

    def key(self, code, key, key_code, wait=0.05):
        base = {'code': code, 'key': key, 'windowsVirtualKeyCode': key_code, 'nativeVirtualKeyCode': key_code}
        self.call('Input.dispatchKeyEvent', dict(base, type='keyDown'))
        self.call('Input.dispatchKeyEvent', dict(base, type='keyUp'))
        time.sleep(wait)

    def shot(self, path):
        r = self.call('Page.captureScreenshot', {'format': 'png'})
        with open(path, 'wb') as f:
            f.write(base64.b64decode(r['data']))
        return path


def main():
    port = int(sys.argv[1])
    url = sys.argv[2]
    c = CDP(port)
    c.navigate(url, settle=3)
    print(c.eval('document.title + " @ " + location.href'))


if __name__ == '__main__':
    main()
