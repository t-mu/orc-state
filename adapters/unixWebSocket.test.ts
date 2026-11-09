import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptKey, connectUnixWebSocket, encodeFrame, FrameDecoder, OPCODE } from './unixWebSocket.ts';

describe('FrameDecoder', () => {
  it('decodes masked and unmasked frames of every length encoding, split across chunks', () => {
    const decoder = new FrameDecoder();
    const sizes = [5, 300, 70_000];
    const bytes = Buffer.concat(sizes.map((size, index) => encodeFrame(OPCODE.text, Buffer.alloc(size, 97 + index), index % 2 === 0)));
    const messages = [];
    for (let offset = 0; offset < bytes.length; offset += 1000) messages.push(...decoder.push(bytes.subarray(offset, offset + 1000)));
    expect(messages.map((message) => [message.opcode, message.payload.length, message.payload[0]])).toEqual([
      [OPCODE.text, 5, 97], [OPCODE.text, 300, 98], [OPCODE.text, 70_000, 99],
    ]);
  });

  it('reassembles a fragmented message around an interleaved control frame', () => {
    const first = encodeFrame(OPCODE.text, Buffer.from('{"a":'), false);
    first[0] &= 0x7f; // not final
    const last = encodeFrame(OPCODE.continuation, Buffer.from('1}'), false);
    const ping = encodeFrame(OPCODE.ping, Buffer.from('p'), false);
    const messages = new FrameDecoder().push(Buffer.concat([first, ping, last]));
    expect(messages.map((message) => [message.opcode, message.payload.toString()])).toEqual([[OPCODE.ping, 'p'], [OPCODE.text, '{"a":1}']]);
  });
});

describe('connectUnixWebSocket', () => {
  let dir: string;
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function listen(onClient: (socket: Socket, key: string) => void): string {
    dir = mkdtempSync(join(tmpdir(), 'orc-ws-'));
    const path = join(dir, 's.sock');
    server = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        const key = /sec-websocket-key: (\S+)/i.exec(chunk.toString('latin1'))?.[1] ?? '';
        onClient(socket, key);
      });
    }).listen(path);
    return path;
  }

  it('upgrades, exchanges text, answers pings and reports the close', async () => {
    const received: string[] = [];
    let serverSaw = '';
    const path = listen((socket, key) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
      const decoder = new FrameDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          if (message.opcode === OPCODE.text) {
            serverSaw = message.payload.toString();
            socket.write(encodeFrame(OPCODE.ping, Buffer.from('hb'), false));
          }
          if (message.opcode === OPCODE.pong) {
            socket.write(encodeFrame(OPCODE.text, Buffer.from(`pong:${message.payload.toString()}`), false));
            socket.end();
          }
        }
      });
    });
    let closed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { closed = resolve; });
    const ws = await connectUnixWebSocket(path, { onMessage: (text) => received.push(text), onClose: () => closed(), timeoutMs: 2000 });
    ws.send('hello');
    await closedPromise;
    expect(serverSaw).toBe('hello');
    expect(received).toEqual(['pong:hb']);
    expect(ws.open).toBe(false);
  });

  it('rejects a server that does not complete the upgrade', async () => {
    const path = listen((socket) => { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
    await expect(connectUnixWebSocket(path, { onMessage: () => {}, onClose: () => {}, timeoutMs: 2000 })).rejects.toThrow('websocket upgrade refused');
  });
});
