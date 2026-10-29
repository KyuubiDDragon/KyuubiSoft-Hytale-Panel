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

export type DockerStreamName = 'stdout' | 'stderr';

/** Text of one stream, in the order it arrived. Raw (TTY) output counts as stdout. */
export interface DockerTextChunk {
  stream: DockerStreamName;
  text: string;
}

interface FrameReader {
  push(chunk: Buffer): DockerTextChunk[];
  end(): DockerTextChunk[];
}

function looksFramed(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
}

function createFrameReader(): FrameReader {
  let mode: 'unknown' | 'raw' | 'framed' = 'unknown';
  let pending: Buffer = Buffer.alloc(0);
  // One decoder per stream, so a multi-byte character split across two frames
  // of the same stream survives an interleaved frame of the other one.
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
  const raw = new StringDecoder('utf8');
  const out = (stream: DockerStreamName, text: string, into: DockerTextChunk[]) => {
    if (text) into.push({ stream, text });
  };

  function drainFrames(into: DockerTextChunk[]): void {
    while (pending.length >= HEADER_BYTES) {
      const stream = pending[0];
      if (stream > 2 || pending[1] !== 0 || pending[2] !== 0 || pending[3] !== 0) {
        // Not a frame after all (corrupt or misdetected): pass the rest through.
        mode = 'raw';
        out('stdout', raw.write(pending), into);
        pending = Buffer.alloc(0);
        return;
      }
      const size = pending.readUInt32BE(4);
      if (pending.length < HEADER_BYTES + size) break; // wait for the rest
      const payload = pending.subarray(HEADER_BYTES, HEADER_BYTES + size);
      // stdin (0) never carries output; 1 = stdout, 2 = stderr.
      if (stream > 0) {
        out(stream === 1 ? 'stdout' : 'stderr', decoders[stream - 1].write(payload), into);
      }
      pending = pending.subarray(HEADER_BYTES + size);
    }
  }

  return {
    push(chunk: Buffer): DockerTextChunk[] {
      const result: DockerTextChunk[] = [];
      if (!chunk || chunk.length === 0) return result;
      if (mode === 'raw') {
        out('stdout', raw.write(chunk), result);
        return result;
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (mode === 'unknown') {
        if (pending.length < 4) return result;
        mode = looksFramed(pending) ? 'framed' : 'raw';
        if (mode === 'raw') {
          out('stdout', raw.write(pending), result);
          pending = Buffer.alloc(0);
          return result;
        }
      }
      drainFrames(result);
      return result;
    },
    end(): DockerTextChunk[] {
      const result: DockerTextChunk[] = [];
      if (pending.length) {
        // Fewer than 4 bytes in total are plain text; of a truncated frame keep the payload.
        if (mode !== 'framed') {
          out('stdout', raw.write(pending), result);
        } else if (pending.length > HEADER_BYTES) {
          out(
            pending[0] === 2 ? 'stderr' : 'stdout',
            raw.write(pending.subarray(HEADER_BYTES)),
            result,
          );
        }
        pending = Buffer.alloc(0);
      }
      out('stdout', decoders[0].end(), result);
      out('stderr', decoders[1].end(), result);
      out('stdout', raw.end(), result);
      return result;
    },
  };
}

export interface DockerOutputDecoder {
  /** Feed a chunk; returns the text that is complete so far. */
  push(chunk: Buffer): string;
  /** Flush what is left at the end of the stream. */
  end(): string;
}

const joinText = (chunks: DockerTextChunk[]) => chunks.map((c) => c.text).join('');

export function createDockerOutputDecoder(): DockerOutputDecoder {
  const reader = createFrameReader();
  return {
    push: (chunk) => joinText(reader.push(chunk)),
    end: () => joinText(reader.end()),
  };
}

/** Decode a complete log or exec buffer. */
export function decodeDockerOutput(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf;
  const decoder = createDockerOutputDecoder();
  return decoder.push(buf) + decoder.end();
}

/** One complete output line, without its line break. */
export interface DockerLine {
  stream: DockerStreamName;
  text: string;
}

export interface DockerLineDecoder {
  /** Feed a chunk; returns the lines completed by it. */
  push(chunk: Buffer): DockerLine[];
  /** The unterminated rest of each stream at the end. */
  end(): DockerLine[];
}

// A line longer than this is passed on in pieces, so a stream that never
// sends a line break cannot grow the buffer without bound.
export const MAX_LINE_CHARS = 64 * 1024;

/**
 * Splits Docker output into lines, per stream: stdout and stderr frames
 * interleave, and a line of one stream may span several frames and chunks.
 */
export function createDockerLineDecoder(maxLineChars: number = MAX_LINE_CHARS): DockerLineDecoder {
  const reader = createFrameReader();
  const partial: Record<DockerStreamName, string> = { stdout: '', stderr: '' };

  function split(chunks: DockerTextChunk[], into: DockerLine[]): void {
    for (const { stream, text } of chunks) {
      let rest = partial[stream] + text;
      let nl: number;
      while ((nl = rest.indexOf('\n')) >= 0) {
        into.push({ stream, text: stripTrailingCr(rest.slice(0, nl)) });
        rest = rest.slice(nl + 1);
      }
      while (rest.length > maxLineChars) {
        into.push({ stream, text: rest.slice(0, maxLineChars) });
        rest = rest.slice(maxLineChars);
      }
      partial[stream] = rest;
    }
  }

  return {
    push(chunk: Buffer): DockerLine[] {
      const lines: DockerLine[] = [];
      split(reader.push(chunk), lines);
      return lines;
    },
    end(): DockerLine[] {
      const lines: DockerLine[] = [];
      split(reader.end(), lines);
      for (const stream of ['stdout', 'stderr'] as const) {
        if (partial[stream]) lines.push({ stream, text: stripTrailingCr(partial[stream]) });
        partial[stream] = '';
      }
      return lines;
    },
  };
}

function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** All lines of a complete log buffer. */
export function decodeDockerLines(buf: Buffer | string): DockerLine[] {
  if (typeof buf === 'string') {
    const lines = buf
      .split('\n')
      .map((text) => ({ stream: 'stdout' as const, text: stripTrailingCr(text) }));
    if (lines.length && lines[lines.length - 1].text === '') lines.pop();
    return lines;
  }
  const decoder = createDockerLineDecoder();
  return [...decoder.push(buf), ...decoder.end()];
}
