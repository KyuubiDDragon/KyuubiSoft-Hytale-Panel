import DOMPurify from 'dompurify'

// Strict allowlist for content coming from external sources (CurseForge,
// Modtale, plugin authors). Anything not on these lists is dropped. Links
// are forced to open in a new tab with noopener/noreferrer so injected
// anchors can't hijack the parent window.
// No explicit DOMPurify.Config annotation — dompurify v3 no longer exposes it
// as a namespace type; the object literal is structurally compatible with
// sanitize()'s config parameter.
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong',
    'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'target', 'rel'],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer nofollow')
  }
})

export function sanitizeHtml(input: string | null | undefined): string {
  if (!input) return ''
  return DOMPurify.sanitize(input, SANITIZE_CONFIG) as unknown as string
}
