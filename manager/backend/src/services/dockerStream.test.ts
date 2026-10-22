/**
 * Docker output decoding. Without a TTY (the game container's default now)
 * Docker frames stdout/stderr; the frames arrive split at arbitrary points.
 */
import { describe, it, expect } from 'vitest';
import { createDockerOutputDecoder, decodeDockerOutput } from './dockerStream.js';

function frame(stream: 1 | 2, payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function feedInPieces(buf: Buffer, size: number): string {
  const decoder = createDockerOutputDecoder();
  let text = '';
  for (let i = 0; i < buf.length; i += size) text += decoder.push(buf.subarray(i, i + size));
  return text + decoder.end();
}

describe('docker output decoding', () => {
  const log = Buffer.concat([
    frame(1, '2026-10-22T10:00:00.000000000Z [INFO] Server started\n'),
    frame(2, '2026-10-22T10:00:01.000000000Z [WARN] Something odd\n'),
    frame(1, '2026-10-22T10:00:02.000000000Z [INFO] Grüße, ünïcödé\n'),
  ]);
  const expected =
    '2026-10-22T10:00:00.000000000Z [INFO] Server started\n' +
    '2026-10-22T10:00:01.000000000Z [WARN] Something odd\n' +
    '2026-10-22T10:00:02.000000000Z [INFO] Grüße, ünïcödé\n';

  it('strips the frame headers of a non-TTY log', () => {
    expect(decodeDockerOutput(log)).toBe(expected);
  });

  it('decodes the same text however the frames are split across chunks', () => {
    for (const size of [1, 3, 7, 8, 9, 13, 64]) {
      expect(feedInPieces(log, size)).toBe(expected);
    }
  });

  it('keeps a multi-byte character that is split across two frames', () => {
    const euro = Buffer.from('€', 'utf8'); // 3 bytes
    const buf = Buffer.concat([
      frame(1, Buffer.concat([Buffer.from('price: '), euro.subarray(0, 1)])),
      frame(1, Buffer.concat([euro.subarray(1), Buffer.from('5\n')])),
    ]);
    expect(feedInPieces(buf, 5)).toBe('price: €5\n');
  });

  it('passes the raw output of a TTY container through unchanged', () => {
    const raw = Buffer.from('[INFO] Hello from a TTY container\n\x1b[32mgreen\x1b[0m\n');
    expect(decodeDockerOutput(raw)).toBe(raw.toString('utf8'));
    expect(feedInPieces(raw, 2)).toBe(raw.toString('utf8'));
  });

  it('handles empty and very short output', () => {
    expect(decodeDockerOutput(Buffer.alloc(0))).toBe('');
    expect(decodeDockerOutput(Buffer.from('ok'))).toBe('ok');
    expect(decodeDockerOutput('already text')).toBe('already text');
  });

  it('keeps the payload of a frame cut off at the end of the stream', () => {
    const cut = frame(1, 'complete\n').subarray(0, 8 + 4);
    expect(decodeDockerOutput(cut)).toBe('comp');
  });
});
