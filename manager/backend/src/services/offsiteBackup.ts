/**
 * Off-site backup uploads to any S3-compatible object store
 * (AWS S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO, …).
 *
 * OFF by default. Enabled via config.offsiteBackup. Uploads are signed with
 * native AWS Signature V4 (HMAC-SHA256 over the canonical request) using only
 * Node's built-in `crypto` and `https` — no SDK dependency. The request body
 * is streamed from disk with an UNSIGNED-PAYLOAD content hash so large
 * tarballs are never buffered in memory.
 *
 * Path-style addressing (https://host/bucket/key) is used for the broadest
 * compatibility across providers.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { URL } from 'url';
import { getConfig } from './configService.js';
import { logger } from '../utils/logger.js';

type OffsiteConfig = NonNullable<Awaited<ReturnType<typeof getConfig>>['offsiteBackup']>;

export interface OffsiteResult {
  success: boolean;
  key?: string;
  url?: string;
  error?: string;
  statusCode?: number;
}

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmac(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 encoding for a single path segment (keeps unreserved chars). */
function encodeSegment(seg: string): string {
  return encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Resolve the endpoint host/protocol for a config (AWS default if blank). */
function resolveEndpoint(cfg: OffsiteConfig): { protocol: string; host: string; port?: number } {
  const raw = (cfg.endpoint || '').trim();
  if (raw) {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return { protocol: u.protocol.replace(':', ''), host: u.hostname, port: u.port ? Number(u.port) : undefined };
  }
  return { protocol: 'https', host: `s3.${cfg.region || 'us-east-1'}.amazonaws.com` };
}

/** Build the off-site object key for a backup file (prefix + filename). */
export function buildKey(cfg: OffsiteConfig, filename: string): string {
  const prefix = (cfg.prefix || '').replace(/^\/+/, '');
  const joined = prefix ? `${prefix.replace(/\/?$/, '/')}${filename}` : filename;
  return joined.replace(/\/{2,}/g, '/');
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * Upload a single object via a streamed, SigV4-signed PUT.
 * `bodyStat` is the file's size; `now` is injected for testability.
 */
function putObject(
  cfg: OffsiteConfig,
  key: string,
  body: () => NodeJS.ReadableStream,
  contentLength: number,
  now: Date,
): Promise<OffsiteResult> {
  return new Promise((resolve) => {
    const { protocol, host, port } = resolveEndpoint(cfg);
    const { amzDate, dateStamp } = amzDates(now);
    const region = cfg.region || 'us-east-1';
    const service = 's3';

    // Canonical URI: /bucket/encoded/key/segments (path-style).
    const canonicalUri = '/' + [cfg.bucket, ...key.split('/')].map(encodeSegment).join('/');
    const hostHeader = port ? `${host}:${port}` : host;

    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders =
      `host:${hostHeader}\n` +
      `x-amz-content-sha256:${UNSIGNED_PAYLOAD}\n` +
      `x-amz-date:${amzDate}\n`;
    const canonicalRequest = [
      'PUT', canonicalUri, '', canonicalHeaders, signedHeaders, UNSIGNED_PAYLOAD,
    ].join('\n');

    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

    const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const transport = protocol === 'http' ? http : https;
    const req = transport.request(
      {
        method: 'PUT',
        host,
        port,
        path: canonicalUri,
        headers: {
          Host: hostHeader,
          'x-amz-date': amzDate,
          'x-amz-content-sha256': UNSIGNED_PAYLOAD,
          Authorization: authorization,
          'Content-Type': 'application/gzip',
          'Content-Length': contentLength,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve({ success: true, key, url: `${protocol}://${hostHeader}${canonicalUri}`, statusCode: status });
          } else {
            const text = Buffer.concat(chunks).toString('utf8').slice(0, 500);
            resolve({ success: false, statusCode: status, error: `HTTP ${status}: ${text || 'upload rejected'}` });
          }
        });
      },
    );
    req.on('error', (err) => resolve({ success: false, error: err.message }));
    body().pipe(req);
  });
}

export function isOffsiteConfigured(cfg: OffsiteConfig | undefined): cfg is OffsiteConfig {
  return !!(cfg && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
}

/** Upload a local backup file off-site. Returns a structured result. */
export async function uploadBackup(absolutePath: string, now: Date = new Date()): Promise<OffsiteResult> {
  let cfg: OffsiteConfig | undefined;
  try { cfg = (await getConfig()).offsiteBackup; } catch { /* config not ready */ }
  if (!isOffsiteConfigured(cfg)) return { success: false, error: 'Off-site backup is not configured' };
  if (!fs.existsSync(absolutePath)) return { success: false, error: 'Backup file not found' };

  const filename = path.basename(absolutePath);
  const key = buildKey(cfg, filename);
  const size = fs.statSync(absolutePath).size;
  try {
    const result = await putObject(cfg, key, () => fs.createReadStream(absolutePath), size, now);
    if (result.success) logger.info(`[Offsite] uploaded ${filename} → ${cfg.bucket}/${key}`);
    else logger.warn(`[Offsite] upload failed for ${filename}: ${result.error}`);
    return result;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'upload failed' };
  }
}

/** Fire-and-forget auto-upload used by createBackup() when uploadOnBackup is on. */
export function uploadBackupAsync(absolutePath: string): void {
  void (async () => {
    try {
      const cfg = (await getConfig()).offsiteBackup;
      if (!cfg?.enabled || !cfg.uploadOnBackup || !isOffsiteConfigured(cfg)) return;
      await uploadBackup(absolutePath);
    } catch (err) {
      logger.warn(`[Offsite] async upload error: ${err instanceof Error ? err.message : err}`);
    }
  })();
}

/**
 * Verify credentials by uploading a tiny marker object. A successful PUT proves
 * endpoint/region/bucket/keys are all correct without listing permissions.
 */
export async function testConnection(now: Date = new Date()): Promise<OffsiteResult> {
  let cfg: OffsiteConfig | undefined;
  try { cfg = (await getConfig()).offsiteBackup; } catch { /* config not ready */ }
  if (!isOffsiteConfigured(cfg)) return { success: false, error: 'Off-site backup is not configured' };

  const key = buildKey(cfg, '.kyuubisoft-connection-test');
  const marker = Buffer.from(`kyuubisoft-panel offsite test ${now.toISOString()}\n`, 'utf8');
  const { Readable } = await import('stream');
  return putObject(cfg, key, () => Readable.from(marker), marker.length, now);
}
