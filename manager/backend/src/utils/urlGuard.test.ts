/**
 * Outbound address checks: which addresses count as private and which are
 * never reachable (cloud metadata), and the URL check used when a webhook is
 * saved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { assertSafeOutboundUrl, classifyAddress, UnsafeUrlError } from './urlGuard.js';

afterEach(() => {
  delete process.env.ALLOW_INTERNAL_WEBHOOKS;
});

describe('classifyAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.178.20',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:192.168.1.1',
  ])('%s is private', (address) => {
    expect(classifyAddress(address)).toBe('private');
  });

  it.each([
    '169.254.169.254',
    '169.254.170.2',
    'fd00:ec2::254',
    '100.100.100.200',
    '::ffff:169.254.169.254',
  ])('%s is a metadata address', (address) => {
    expect(classifyAddress(address)).toBe('metadata');
  });

  it.each(['1.1.1.1', '140.82.112.3', '172.32.0.1', '2606:4700::1111', '100.64.0.1'])(
    '%s is public',
    (address) => {
      expect(classifyAddress(address)).toBe('public');
    },
  );

  // NAT64 (64:ff9b::/96), 6to4 (2002::/16) and Teredo (2001:0::/32) carry an
  // IPv4 address; a host with such routing reaches that address.
  describe('IPv6 addresses that carry an IPv4 address', () => {
    it.each([
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '2002:a9fe:a9fe::1',
      '2001:0:4136:e378:8000:63bf:5601:5601',
    ])('%s is the metadata address it carries', (address) => {
      expect(classifyAddress(address)).toBe('metadata');
    });

    it.each([
      '64:ff9b::7f00:1',
      '64:ff9b::10.0.0.1',
      '2002:c0a8:101::1',
      '2001:0:4136:e378:8000:63bf:3fff:fffe',
      // local-use NAT64: where the IPv4 address sits depends on the network
      '64:ff9b:1::a00:1',
    ])('%s is private', (address) => {
      expect(classifyAddress(address)).toBe('private');
    });

    it.each([
      '64:ff9b::808:808',
      '64:ff9b::8.8.8.8',
      '2002:808:808::1',
      '2001:0:4136:e378::f7f7:f7f7',
    ])('%s stays public like the address it carries', (address) => {
      expect(classifyAddress(address)).toBe('public');
    });
  });
});

describe('assertSafeOutboundUrl', () => {
  it('accepts a public https URL', () => {
    expect(assertSafeOutboundUrl('https://discord.com/api/webhooks/1/x').hostname).toBe(
      'discord.com',
    );
  });

  it.each([
    'http://localhost:8080/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd12::1]/',
    'http://printer.local/',
    'http://2130706433/',
  ])('refuses the private target %s', (url) => {
    expect(() => assertSafeOutboundUrl(url)).toThrow(UnsafeUrlError);
  });

  it('refuses other schemes even when internal targets are allowed', () => {
    process.env.ALLOW_INTERNAL_WEBHOOKS = 'true';
    expect(() => assertSafeOutboundUrl('file:///etc/passwd')).toThrow(UnsafeUrlError);
    expect(() => assertSafeOutboundUrl('gopher://example.com/')).toThrow(UnsafeUrlError);
  });

  it('allows private targets with ALLOW_INTERNAL_WEBHOOKS, but never metadata', () => {
    process.env.ALLOW_INTERNAL_WEBHOOKS = 'true';
    expect(assertSafeOutboundUrl('http://192.168.1.5:5678/hook').hostname).toBe('192.168.1.5');
    expect(() => assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      UnsafeUrlError,
    );
    expect(() => assertSafeOutboundUrl('http://metadata.google.internal/')).toThrow(UnsafeUrlError);
  });
});
