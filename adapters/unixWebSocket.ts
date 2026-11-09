/**
 * adapters/unixWebSocket.ts — a minimal WebSocket client over a Unix socket.
 *
 * `codex app-server --listen unix://PATH` speaks WebSocket on the socket
 * (RFC 6455 framing, one JSON-RPC message per text frame). Node's global
 * WebSocket cannot dial a Unix socket without undici's dispatcher, so this
 * module does the handshake and framing itself: text, close, ping/pong and
 * fragmented messages; no extensions.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** The Sec-WebSocket-Accept value for a handshake key. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** One final frame; a client must mask, a server must not. */
export function encodeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
  const length = payload.length;
  const lengthBytes = length < 126 ? 0 : length < 0x10000 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + (masked ? 4 : 0));
  header[0] = 0x80 | opcode;
  header[1] = (masked ? 0x80 : 0) | (lengthBytes === 0 ? length : lengthBytes === 2 ? 126 : 127);
  if (lengthBytes === 2) header.writeUInt16BE(length, 2);
  if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (!masked) return Buffer.concat([header, payload]);
  const mask = randomBytes(4);
  mask.copy(header, 2 + lengthBytes);
  const body = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) body[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, body]);
}

/** Reassembles frames (split, batched, masked or fragmented) into messages. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;

  push(chunk: Buffer): Array<{ opcode: number; payload: Buffer }> {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages: Array<{ opcode: number; payload: Buffer }> = [];
    for (;;) {
      if (this.buffer.length < 2) break;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) break;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) break;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (masked) for (let index = 0; index < length; index += 1) payload[index] ^= this.buffer[maskOffset + (index % 4)];
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode >= 0x8) { messages.push({ opcode, payload }); continue; }
      if (opcode !== OPCODE.continuation) { this.fragments = []; this.fragmentOpcode = opcode; }
      this.fragments.push(payload);
      if (!fin) continue;
      messages.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) });
      this.fragments = [];
    }
    return messages;
  }
}

export interface UnixWebSocket {
  send(text: string): void;
  /** Close the connection; `onClose` listeners still run. */
  close(): void;
  readonly open: boolean;
}

/**
 * Dial `socketPath` and complete the WebSocket upgrade. `onMessage` gets each
 * text message; `onClose` runs once when the connection ends for any reason.
 */
export function connectUnixWebSocket(
  socketPath: string,
  { onMessage, onClose, timeoutMs }: { onMessage: (text: string) => void; onClose: () => void; timeoutMs: number },
): Promise<UnixWebSocket> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const socket: Socket = createConnection(socketPath);
    const decoder = new FrameDecoder();
    let upgraded = false;
    let open = true;
    let header = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error(`websocket handshake on ${socketPath} timed out after ${timeoutMs}ms`)), timeoutMs);
    function fail(error: Error) {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }
    const connection: UnixWebSocket = {
      send(text: string) {
        if (!open) throw new Error('websocket is closed');
        socket.write(encodeFrame(OPCODE.text, Buffer.from(text, 'utf8'), true));
      },
      close() {
        if (!open) return;
        try { socket.write(encodeFrame(OPCODE.close, Buffer.alloc(0), true)); } catch { /* already gone */ }
        socket.end();
        socket.destroy();
      },
      get open() { return open; },
    };
    function deliver(chunk: Buffer) {
      for (const message of decoder.push(chunk)) {
        if (message.opcode === OPCODE.text) onMessage(message.payload.toString('utf8'));
        else if (message.opcode === OPCODE.ping && open) socket.write(encodeFrame(OPCODE.pong, message.payload, true));
        else if (message.opcode === OPCODE.close) connection.close();
      }
    }
    socket.on('connect', () => {
      socket.write([
        'GET / HTTP/1.1', 'Host: localhost', 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk: Buffer) => {
      if (upgraded) { deliver(chunk); return; }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end === -1) return;
      const lines = header.subarray(0, end).toString('latin1').split('\r\n');
      const accept = lines.find((line) => line.toLowerCase().startsWith('sec-websocket-accept:'))?.slice(21).trim();
      if (!/^HTTP\/1\.1 101\b/.test(lines[0] ?? '') || accept !== acceptKey(key)) {
        fail(new Error(`websocket upgrade refused on ${socketPath}: ${lines[0] ?? 'no status line'}`));
        return;
      }
      upgraded = true;
      clearTimeout(timer);
      resolve(connection);
      const rest = header.subarray(end + 4);
      if (rest.length) deliver(rest);
    });
    socket.on('error', (error) => { if (!upgraded) fail(error); });
    socket.on('close', () => {
      open = false;
      if (upgraded) onClose();
      else fail(new Error(`connection to ${socketPath} closed before the websocket upgrade`));
    });
  });
}
