/**
 * Conservative HTML sanitizer for third-party text (mod changelogs from
 * CurseForge, Modtale and GitHub releases).
 *
 * The frontend renders changelogs with DOMPurify; this is the server-side
 * second layer so the API never hands raw author-controlled markup to a
 * client. It does not filter the input in place — it re-builds the output:
 *
 *  - text is HTML-escaped (existing character references are kept);
 *  - only tags on ALLOWED_TAGS are re-emitted, with only the attributes on
 *    ALLOWED_ATTRS, and every attribute value is re-escaped;
 *  - `href`/`src` must parse as absolute http(s) URLs, anything else
 *    (`javascript:`, `data:`, relative panel paths, ...) is dropped;
 *  - script-like elements (DROP_CONTENT_TAGS) are removed together with
 *    their content, comments and other markup are removed;
 *  - an unterminated tag ends the markup: the rest is emitted as text.
 *
 * Plain text and Markdown pass through readable (only `<`, `>`, `&`, quotes
 * are escaped). Scanning is linear in the input length.
 */

// prettier-ignore
const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'span',
  'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u',
  'ul',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img']);

const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title']),
};

const URL_ATTRS = new Set(['href', 'src']);

// Elements whose content is markup/code rather than readable text.
// prettier-ignore
const DROP_CONTENT_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'noembed',
  'noframes', 'template', 'textarea', 'title', 'svg', 'math', 'select', 'xmp',
]);

/** Changelogs larger than this are truncated before sanitizing. */
export const MAX_SANITIZED_INPUT_LENGTH = 100_000;

const TAG_START = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const CHAR_REF = /&(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/y;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\xa0',
};

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape text, keeping well-formed character references such as `&amp;`. */
function escapeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '&') {
      CHAR_REF.lastIndex = i;
      out += CHAR_REF.test(text) ? '&' : '&amp;';
    } else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z]+);?/g, (match, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/**
 * Absolute http(s) URL (normalized) or null. Strips surrounding control
 * characters/spaces and embedded tabs/newlines the way browsers do before
 * resolving a URL, so `java\tscript:` can't sneak past the scheme check.
 */
export function safeHttpUrl(raw: string): string | null {
  const cleaned = decodeEntities(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
    .replace(/[\t\n\r]/g, '');
  try {
    const url = new URL(cleaned);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function buildAttributes(tag: string, rawAttrs: string): string {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) return '';
  const seen = new Set<string>();
  let out = '';
  ATTRIBUTE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTRIBUTE.exec(rawAttrs)) !== null) {
    const name = m[1].toLowerCase();
    if (!allowed.has(name) || seen.has(name)) continue;
    const rawValue = m[2] ?? m[3] ?? m[4];
    if (rawValue === undefined) continue;
    const value = URL_ATTRS.has(name) ? safeHttpUrl(rawValue) : decodeEntities(rawValue);
    if (value === null) continue;
    seen.add(name);
    out += ` ${name}="${escapeAttr(value)}"`;
  }
  if (tag === 'a' && seen.has('href')) out += ' rel="noopener noreferrer nofollow" target="_blank"';
  return out;
}

/** Index just past the `>` that closes the tag starting at `from`, or -1. */
function findTagEnd(input: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i + 1;
    }
  }
  return -1;
}

/**
 * Sanitize author-supplied HTML/Markdown for rendering as HTML.
 * Returns undefined for empty or non-string input.
 */
export function sanitizeExternalHtml(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  const source = input.slice(0, MAX_SANITIZED_INPUT_LENGTH).replace(/\0/g, '');
  let out = '';
  let pos = 0;

  while (pos < source.length) {
    const lt = source.indexOf('<', pos);
    if (lt === -1) {
      out += escapeText(source.slice(pos));
      break;
    }
    out += escapeText(source.slice(pos, lt));

    if (source.startsWith('<!-->', lt) || source.startsWith('<!--->', lt)) {
      // Browsers treat these as complete (empty) comments.
      pos = source.indexOf('>', lt) + 1;
      continue;
    }
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      pos = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source[lt + 1] === '!' || source[lt + 1] === '?') {
      // <!DOCTYPE>, <![CDATA[, <?xml ...?> — declarations, never content.
      const end = source.indexOf('>', lt + 2);
      pos = end === -1 ? source.length : end + 1;
      continue;
    }

    const start = TAG_START.exec(source.slice(lt, lt + 64));
    if (!start) {
      out += '&lt;';
      pos = lt + 1;
      continue;
    }

    const end = findTagEnd(source, lt + start[0].length);
    if (end === -1) {
      // Unterminated tag: a browser would swallow the rest as attributes.
      out += escapeText(source.slice(lt));
      break;
    }

    const isClosing = start[1] === '/';
    const tag = start[2].toLowerCase();
    pos = end;

    if (DROP_CONTENT_TAGS.has(tag)) {
      if (!isClosing) {
        // Skip to the matching end tag. `tag` is from DROP_CONTENT_TAGS, so
        // it is safe to embed in the pattern.
        const closeTag = new RegExp(`</${tag}[\\s/>]`, 'gi');
        closeTag.lastIndex = end;
        const close = closeTag.exec(source);
        const closeEnd = close ? source.indexOf('>', close.index) : -1;
        pos = closeEnd === -1 ? source.length : closeEnd + 1;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) continue;

    if (isClosing) {
      if (!VOID_TAGS.has(tag)) out += `</${tag}>`;
      continue;
    }
    const rawAttrs = source.slice(lt + start[0].length, end - 1);
    out += `<${tag}${buildAttributes(tag, rawAttrs)}>`;
  }

  return out;
}
