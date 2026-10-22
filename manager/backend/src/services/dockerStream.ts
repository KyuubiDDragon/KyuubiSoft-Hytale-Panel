/**
 * Decoding of Docker log/exec output.
 *
 * A container started with a TTY sends raw bytes. Without one (the game
 * container's default since `tty: false`, and every `docker exec` the panel
 * runs) Docker frames the output: an 8-byte header [stream, 0, 0, 0, size as
 * uint32 BE] followed by `size` payload bytes, where stream is 1 (stdout) or
 * 2 (stderr). Frames are split arbitrarily across network chunks, so a live
 * stream needs a stateful decoder.
 *
 * The shape is detected from the first bytes: a framed stream always starts
 * with [0|1|2, 0, 0, 0], which plain log text never does. That keeps
 * containers created before the switch (still with a TTY) working.
 */
import { StringDecoder } from 'string_decoder';

const HEADER_BYTES = 8;

export interface DockerOutputDecoder {
  /** Feed a chunk; returns the text that is complete so far. */
  push(chunk: Buffer): string;
  /** Flush what is left at the end of the stream. */
  end(): string;
}

function looksFramed(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
}

export function createDockerOutputDecoder(): DockerOutputDecoder {
  let mode: 'unknown' | 'raw' | 'framed' = 'unknown';
  let pending: Buffer = Buffer.alloc(0);
  // One decoder per stream, so a multi-byte character split across two frames
  // of the same stream survives an interleaved frame of the other one.
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
  const raw = new StringDecoder('utf8');

  function drainFrames(): string {
    let text = '';
    while (pending.length >= HEADER_BYTES) {
      const stream = pending[0];
      if (stream > 2 || pending[1] !== 0 || pending[2] !== 0 || pending[3] !== 0) {
        // Not a frame after all (corrupt or misdetected): pass the rest through.
        mode = 'raw';
        text += raw.write(pending);
        pending = Buffer.alloc(0);
        return text;
      }
      const size = pending.readUInt32BE(4);
      if (pending.length < HEADER_BYTES + size) break; // wait for the rest
      const payload = pending.subarray(HEADER_BYTES, HEADER_BYTES + size);
      // stdin (0) never carries output; 1 = stdout, 2 = stderr.
      if (stream > 0) text += decoders[stream - 1].write(payload);
      pending = pending.subarray(HEADER_BYTES + size);
    }
    return text;
  }

  return {
    push(chunk: Buffer): string {
      if (!chunk || chunk.length === 0) return '';
      if (mode === 'raw') return raw.write(chunk);
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (mode === 'unknown') {
        if (pending.length < 4) return '';
        mode = looksFramed(pending) ? 'framed' : 'raw';
        if (mode === 'raw') {
          const text = raw.write(pending);
          pending = Buffer.alloc(0);
          return text;
        }
      }
      return drainFrames();
    },
    end(): string {
      let text = '';
      if (pending.length) {
        // Fewer than 4 bytes in total are plain text; of a truncated frame keep the payload.
        if (mode !== 'framed') text += raw.write(pending);
        else if (pending.length > HEADER_BYTES) text += raw.write(pending.subarray(HEADER_BYTES));
        pending = Buffer.alloc(0);
      }
      return text + decoders[0].end() + decoders[1].end() + raw.end();
    },
  };
}

/** Decode a complete log or exec buffer. */
export function decodeDockerOutput(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf;
  const decoder = createDockerOutputDecoder();
  return decoder.push(buf) + decoder.end();
}
