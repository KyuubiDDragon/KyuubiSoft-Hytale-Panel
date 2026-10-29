/**
 * JSON for files the game server writes.
 *
 * The server stores Java longs (world seeds, timestamps in mod data) as plain
 * JSON integers. JSON.parse turns anything above 2^53 into the nearest double,
 * so a read-modify-write would silently change a seed. parseLosslessJson keeps
 * such integers as raw JSON text (JSON.rawJSON, Node 21+) and stringifyJson
 * writes them back digit for digit.
 */

interface RawJsonApi {
  rawJSON(text: string): unknown;
  isRawJSON(value: unknown): boolean;
}

const nativeJson = JSON as unknown as Partial<RawJsonApi>;
const INTEGER_LITERAL = /^-?\d+$/;

/** Whether `value` is an integer JSON.parse could not hold exactly (kept as raw JSON). */
export function isRawJsonNumber(value: unknown): boolean {
  return typeof nativeJson.isRawJSON === 'function' && nativeJson.isRawJSON(value);
}

/** A plain JSON object (not an array, not a raw JSON number). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !isRawJsonNumber(value)
  );
}

/** JSON.parse that keeps integers beyond 2^53 exactly. Tolerates a leading BOM. */
export function parseLosslessJson(text: string): unknown {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(source, (_key, value: unknown, context?: { source?: string }) => {
    if (
      typeof value === 'number' &&
      !Number.isSafeInteger(value) &&
      context?.source !== undefined &&
      INTEGER_LITERAL.test(context.source) &&
      typeof nativeJson.rawJSON === 'function'
    ) {
      return nativeJson.rawJSON(context.source);
    }
    return value;
  });
}

/** Pretty JSON (2 spaces, like the server's own files); raw integers stay as they were. */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
