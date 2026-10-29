/** A value as one safe shell word: in single quotes, with any single quote inside escaped. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
