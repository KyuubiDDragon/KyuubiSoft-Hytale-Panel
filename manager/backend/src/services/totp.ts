/**
 * 2FA / TOTP setup, verification and backup codes.
 *
 * The TOTP secret lives in users.json next to the password hash. Backup
 * codes are bcrypt-hashed single-use codes the user gets exactly once at
 * enrollment time; consuming a code marks it as spent.
 *
 * All writes go through the users service's serialised updateUsers(). Slow
 * bcrypt work happens outside that lock; the write step re-checks the state
 * it relied on, so two parallel requests cannot both consume the same code.
 */
import { authenticator } from 'otplib';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import qrcode from 'qrcode';
import { readUsersFile, updateUsers } from './users.js';

authenticator.options = { window: 1, step: 30 };

interface UserWithTotp {
  username: string;
  totpSecret?: string;
  totpEnabled?: boolean;
  totpPendingSecret?: string;
  backupCodeHashes?: string[];
  // Highest TOTP time-step already accepted for this user. Replay protection:
  // a code is rejected if its step is <= this, so a captured 6-digit code can't
  // be reused inside the ±1 drift window (~90 s).
  totpLastUsedStep?: number;
  // Other user fields exist but we don't touch them here.
  [key: string]: unknown;
}

const TOTP_STEP_SECONDS = 30;

interface TotpUsersData {
  users: UserWithTotp[];
}

// Current record of one user; null when users.json does not exist yet.
// Throws when users.json is corrupt — 2FA must never fail open.
async function readUser(username: string): Promise<UserWithTotp | undefined> {
  const data = await readUsersFile<TotpUsersData>();
  return data?.users.find((u) => u.username === username);
}

// Serialised read-modify-write of one user's record. `mutate` returns false
// to leave users.json untouched; throwing aborts without writing.
async function updateUser(
  username: string,
  mutate: (user: UserWithTotp | undefined) => boolean | void,
): Promise<void> {
  await updateUsers<TotpUsersData>((data) =>
    mutate(data.users.find((u) => u.username === username)),
  );
}

export interface TotpStartResult {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export async function startTotpEnrollment(
  username: string,
  issuer = 'KyuubiSoft Panel',
): Promise<TotpStartResult> {
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(username, issuer, secret);
  const qrDataUrl = await qrcode.toDataURL(otpauthUrl);

  await updateUser(username, (user) => {
    if (!user) throw new Error('User not found');
    if (user.totpEnabled) throw new Error('2FA is already enabled');
    user.totpPendingSecret = secret;
  });

  return { secret, otpauthUrl, qrDataUrl };
}

export async function verifyAndEnableTotp(
  username: string,
  code: string,
): Promise<{ backupCodes: string[] }> {
  const snapshot = await readUser(username);
  const pendingSecret = snapshot?.totpPendingSecret;
  if (!pendingSecret) throw new Error('No pending 2FA enrollment');

  const ok = authenticator.verify({ token: code, secret: pendingSecret });
  if (!ok) throw new Error('Invalid code');

  const backupCodes = generateBackupCodes();
  const backupCodeHashes = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));

  await updateUser(username, (user) => {
    // A restarted or already finished enrollment changed the pending secret
    // while we were hashing — the verified code belongs to a stale secret.
    if (!user || user.totpPendingSecret !== pendingSecret)
      throw new Error('No pending 2FA enrollment');
    user.totpSecret = pendingSecret;
    user.totpEnabled = true;
    delete user.totpPendingSecret;
    user.backupCodeHashes = backupCodeHashes;
  });
  return { backupCodes };
}

export async function disableTotp(username: string): Promise<void> {
  await updateUser(username, (user) => {
    if (!user) throw new Error('User not found');
    delete user.totpSecret;
    delete user.totpPendingSecret;
    delete user.backupCodeHashes;
    user.totpEnabled = false;
  });
}

export async function regenerateBackupCodes(username: string): Promise<string[]> {
  const snapshot = await readUser(username);
  if (!snapshot || !snapshot.totpEnabled) throw new Error('2FA is not enabled');
  const backupCodes = generateBackupCodes();
  const backupCodeHashes = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));
  await updateUser(username, (user) => {
    if (!user || !user.totpEnabled) throw new Error('2FA is not enabled');
    user.backupCodeHashes = backupCodeHashes;
  });
  return backupCodes;
}

export async function isTotpEnabled(username: string): Promise<boolean> {
  const user = await readUser(username);
  return !!user?.totpEnabled;
}

/**
 * Verify either a TOTP code (against the live secret) or a single-use
 * backup code. Returns true if accepted; backup codes are consumed.
 */
export async function verifyTotpOrBackup(username: string, code: string): Promise<boolean> {
  if (!code) return false;
  const snapshot = await readUser(username);
  if (!snapshot || !snapshot.totpEnabled || !snapshot.totpSecret) return false;
  const secret = snapshot.totpSecret;
  let accepted = false;

  // 6-digit numeric → TOTP, anything else → backup code
  if (/^\d{6}$/.test(code.trim())) {
    const token = code.trim();
    // checkDelta returns the matched step offset (−1/0/+1 within the window),
    // or null if no match. We turn that into an absolute step number so we can
    // reject reuse of an already-accepted code.
    const delta = authenticator.checkDelta(token, secret);
    if (delta === null) return false;
    const usedStep = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + delta;
    await updateUser(username, (user) => {
      if (!user || !user.totpEnabled || user.totpSecret !== secret) return false;
      const lastStep = typeof user.totpLastUsedStep === 'number' ? user.totpLastUsedStep : -1;
      if (usedStep <= lastStep) return false; // replay within the drift window
      user.totpLastUsedStep = usedStep;
      accepted = true;
    });
    return accepted;
  }
  // Codes are hashed exactly as issued (XXXX-XXXX). Accept them with or
  // without the dash and in any case by rebuilding that form; comparing the
  // dash-less input against the hash never matched.
  const normalized = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (normalized.length !== 8) return false;
  const issuedForm = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
  if (!snapshot.backupCodeHashes || snapshot.backupCodeHashes.length === 0) return false;
  let matchedHash: string | undefined;
  for (const hash of snapshot.backupCodeHashes) {
    if (await bcrypt.compare(issuedForm, hash)) {
      matchedHash = hash;
      break;
    }
  }
  if (!matchedHash) return false;
  // Consume — only if no parallel request consumed or replaced it first.
  await updateUser(username, (user) => {
    const index = user?.backupCodeHashes?.indexOf(matchedHash!) ?? -1;
    if (!user || !user.totpEnabled || index === -1) return false;
    user.backupCodeHashes!.splice(index, 1);
    accepted = true;
  });
  return accepted;
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
