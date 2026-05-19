/**
 * 2FA / TOTP setup, verification and backup codes.
 *
 * The TOTP secret lives in users.json next to the password hash. Backup
 * codes are bcrypt-hashed single-use codes the user gets exactly once at
 * enrollment time; consuming a code marks it as spent.
 */
import { authenticator } from 'otplib';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import qrcode from 'qrcode';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');

authenticator.options = { window: 1, step: 30 };

interface UserWithTotp {
  username: string;
  totpSecret?: string;
  totpEnabled?: boolean;
  totpPendingSecret?: string;
  backupCodeHashes?: string[];
  // Other user fields exist but we don't touch them here.
  [key: string]: unknown;
}

async function readUsersRaw(): Promise<{ users: UserWithTotp[] }> {
  return JSON.parse(await readFile(USERS_FILE, 'utf-8')) as { users: UserWithTotp[] };
}
async function writeUsersRaw(data: { users: UserWithTotp[] }): Promise<void> {
  await writeFile(USERS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export interface TotpStartResult {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export async function startTotpEnrollment(username: string, issuer = 'KyuubiSoft Panel'): Promise<TotpStartResult> {
  const data = await readUsersRaw();
  const user = data.users.find(u => u.username === username);
  if (!user) throw new Error('User not found');
  if (user.totpEnabled) throw new Error('2FA is already enabled');

  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(username, issuer, secret);
  const qrDataUrl = await qrcode.toDataURL(otpauthUrl);

  user.totpPendingSecret = secret;
  await writeUsersRaw(data);

  return { secret, otpauthUrl, qrDataUrl };
}

export async function verifyAndEnableTotp(username: string, code: string): Promise<{ backupCodes: string[] }> {
  const data = await readUsersRaw();
  const user = data.users.find(u => u.username === username);
  if (!user || !user.totpPendingSecret) throw new Error('No pending 2FA enrollment');

  const ok = authenticator.verify({ token: code, secret: user.totpPendingSecret });
  if (!ok) throw new Error('Invalid code');

  user.totpSecret = user.totpPendingSecret;
  user.totpEnabled = true;
  delete user.totpPendingSecret;

  const backupCodes = generateBackupCodes();
  user.backupCodeHashes = await Promise.all(backupCodes.map(c => bcrypt.hash(c, 10)));

  await writeUsersRaw(data);
  return { backupCodes };
}

export async function disableTotp(username: string): Promise<void> {
  const data = await readUsersRaw();
  const user = data.users.find(u => u.username === username);
  if (!user) throw new Error('User not found');
  delete user.totpSecret;
  delete user.totpPendingSecret;
  delete user.backupCodeHashes;
  user.totpEnabled = false;
  await writeUsersRaw(data);
}

export async function regenerateBackupCodes(username: string): Promise<string[]> {
  const data = await readUsersRaw();
  const user = data.users.find(u => u.username === username);
  if (!user || !user.totpEnabled) throw new Error('2FA is not enabled');
  const backupCodes = generateBackupCodes();
  user.backupCodeHashes = await Promise.all(backupCodes.map(c => bcrypt.hash(c, 10)));
  await writeUsersRaw(data);
  return backupCodes;
}

export async function isTotpEnabled(username: string): Promise<boolean> {
  try {
    const data = await readUsersRaw();
    const user = data.users.find(u => u.username === username);
    return !!user?.totpEnabled;
  } catch {
    return false;
  }
}

/**
 * Verify either a TOTP code (against the live secret) or a single-use
 * backup code. Returns true if accepted; backup codes are consumed.
 */
export async function verifyTotpOrBackup(username: string, code: string): Promise<boolean> {
  if (!code) return false;
  const data = await readUsersRaw();
  const user = data.users.find(u => u.username === username);
  if (!user || !user.totpEnabled || !user.totpSecret) return false;

  // 6-digit numeric → TOTP, anything else → backup code
  if (/^\d{6}$/.test(code.trim())) {
    return authenticator.verify({ token: code.trim(), secret: user.totpSecret });
  }
  const normalized = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!user.backupCodeHashes || user.backupCodeHashes.length === 0) return false;
  for (let i = 0; i < user.backupCodeHashes.length; i++) {
    if (await bcrypt.compare(normalized, user.backupCodeHashes[i])) {
      // Consume
      user.backupCodeHashes.splice(i, 1);
      await writeUsersRaw(data);
      return true;
    }
  }
  return false;
}

function generateBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    // 10 codes of the form XXXX-XXXX (32 bits of entropy each, hex)
    const buf = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${buf.slice(0, 4)}-${buf.slice(4, 8)}`);
  }
  return codes;
}
