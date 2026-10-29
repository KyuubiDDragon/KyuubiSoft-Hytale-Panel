/**
 * TRUST_PROXY is checked against the requests that arrive: trusted without a
 * proxy in front (clients forge X-Forwarded-For and dodge the login limit) or
 * a proxy in front that is not trusted (every client shares one limit) is
 * logged, once per case.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { proxyMismatch, createProxyCheck } from './proxyCheck.js';

describe('proxyMismatch', () => {
  it('flags a trusted proxy header that a client sent straight to the panel', () => {
    expect(proxyMismatch(true, '203.0.113.7', undefined)).toBe('trusted-without-proxy');
    expect(proxyMismatch(true, '192.168.1.20', undefined)).toBe('trusted-without-proxy');
  });

  it('flags a trusted hop that is a public address', () => {
    expect(proxyMismatch(true, '203.0.113.7', '198.51.100.1')).toBe('trusted-without-proxy');
    expect(proxyMismatch(true, '::ffff:203.0.113.7', '198.51.100.1')).toBe('trusted-without-proxy');
  });

  it('accepts a trusted proxy on the host or in a private network', () => {
    expect(proxyMismatch(true, '172.18.0.5', '198.51.100.1')).toBeNull();
    expect(proxyMismatch(true, '::ffff:10.0.0.2', '198.51.100.1')).toBeNull();
    expect(proxyMismatch(true, '127.0.0.1', '198.51.100.1')).toBeNull();
  });

  it('ignores local requests without the header (container health checks)', () => {
    expect(proxyMismatch(true, '127.0.0.1', undefined)).toBeNull();
    expect(proxyMismatch(true, '::1', undefined)).toBeNull();
  });

  it('flags a proxy in front that is not trusted', () => {
    expect(proxyMismatch(false, '172.18.0.5', '198.51.100.1')).toBe('proxy-not-trusted');
  });

  it('stays quiet without TRUST_PROXY and without a proxy', () => {
    expect(proxyMismatch(false, '203.0.113.7', undefined)).toBeNull();
    // A client on the internet sending the header itself is no proxy.
    expect(proxyMismatch(false, '203.0.113.7', '198.51.100.1')).toBeNull();
  });
});

describe('createProxyCheck', () => {
  const request = (peer: string, forwardedFor?: string) =>
    ({
      socket: { remoteAddress: peer },
      headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    }) as unknown as Request;

  it('warns once per case and always lets the request through', () => {
    const warn = vi.fn();
    const check = createProxyCheck(true, warn);
    const next = vi.fn();

    check(request('203.0.113.7'), {} as Response, next);
    check(request('203.0.113.8'), {} as Response, next);
    check(request('172.18.0.5', '198.51.100.1'), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/TRUST_PROXY/);
  });
});
