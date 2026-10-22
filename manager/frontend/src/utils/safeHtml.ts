import DOMPurify from 'dompurify'

// Strict allowlist for content coming from external sources (CurseForge,
// Modtale, GitHub release notes, plugin authors). Anything not on these lists
// is dropped:
//  - no `style`, `class`, `id` or `on*` attributes (`class` would let a mod
//    author pull in utility classes such as `fixed inset-0` and overlay the
//    panel UI with a full-screen link);
//  - `href`/`src` must be absolute http(s) URLs, so `javascript:`, relative
//    panel paths and other schemes are removed (data: stays allowed for <img>
//    only, which is inert);
//  - links always open in a new tab with noopener/noreferrer so an injected
//    anchor can't hijack the parent window.
// No explicit DOMPurify.Config annotation — dompurify v3 no longer exposes it
// as a namespace type; the object literal is structurally compatible with
// sanitize()'s config parameter.
const SANITIZE_CONFIG = {
  // prettier-ignore
  ALLOWED_TAGS: [
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'span',
    'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'svg', 'math'],
  FORBID_ATTR: ['style', 'class', 'id', 'onerror', 'onload', 'onclick', 'onmouseover'],
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer nofollow')
  } else if (node.tagName === 'IMG') {
    // Don't leak the panel URL to whatever host serves changelog images.
    node.setAttribute('referrerpolicy', 'no-referrer')
  }
})

export function sanitizeHtml(input: string | null | undefined): string {
  if (!input) return ''
  return DOMPurify.sanitize(input, SANITIZE_CONFIG) as unknown as string
}
