#!/usr/bin/env node
/**
 * KyuubiSoft Panel — Admin-Recovery CLI
 *
 * Runs INSIDE the manager container against the data volume, independent of
 * the HTTP server, so operators can always recover access:
 *
 *   docker exec -it <stack>-manager node dist/cli.js auth-status
 *   docker exec -it <stack>-manager node dist/cli.js list-users
 *   docker exec -it <stack>-manager node dist/cli.js reset-password <user> [newPassword]
 *   docker exec -it <stack>-manager node dist/cli.js create-admin <user> [password]
 *   docker exec -it <stack>-manager node dist/cli.js disable-2fa <user>
 *
 * Or via docker compose: docker compose exec manager node dist/cli.js ...
 *
 * Design constraints:
 *  - Works whether or not the panel process is running (direct file access;
 *    the server re-reads users.json on every request, so changes apply
 *    immediately).
 *  - `docker exec` runs as root by default while the panel runs as UID 9999.
 *    Every write therefore restores the previous owner/mode of users.json —
 *    otherwise the panel could no longer update the file after a CLI call.
 *  - No import of config.ts / service modules: keeps the CLI free of startup
 *    side effects (dotenv, demo-mode checks, banner logs).
 */
import { readFile, writeFile, rename, stat, chown, chmod } from 'fs/promises';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

const DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SETUP_CONFIG_FILE = path.join(DATA_DIR, 'setup-config.json');

interface CliUser {
  username: string;
  passwordHash: string;
  roleId: string;
  createdAt?: string;
  lastLogin?: string;
  tokenVersion?: number;
  totpEnabled?: boolean;
  totpSecret?: string;
  totpPendingSecret?: string;
  backupCodeHashes?: string[];
  totpLastUsedStep?: number;
  [key: string]: unknown;
}

// Same policy as services/users.ts validatePasswordPolicy — duplicated on
// purpose so the CLI stays import-free; keep both in sync.
const COMMON_SEQUENCES = ['password', 'changeme', '123456789012', 'qwertyuiop', 'administrator'];
function validatePasswordPolicy(password: string, username?: string): string | null {
  if (typeof password !== 'string' || password.length < 12) {
    return 'Password must be at least 12 characters';
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(rx => rx.test(password)).length;
  if (classes < 3) {
    return 'Password must include at least three of: lowercase, uppercase, digit, symbol';
  }
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return 'Password must not contain the username';
  }
  if (COMMON_SEQUENCES.some(c => password.toLowerCase().includes(c))) {
    return 'Password contains a well-known sequence; pick something less guessable';
  }
  return null;
}

function generatePassword(): string {
  // base64url gives upper+lower+digits (3 classes). Loop until the policy is
  // happy in the unlikely case a draw misses a class.
  for (;;) {
    const candidate = crypto.randomBytes(15).toString('base64url'); // 20 chars
    if (validatePasswordPolicy(candidate) === null) return candidate;
  }
}

async function readUsers(): Promise<{ users: CliUser[] }> {
  try {
    const data = JSON.parse(await readFile(USERS_FILE, 'utf-8'));
    if (!Array.isArray(data.users)) return { users: [] };
    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { users: [] };
    throw err;
  }
}

/**
 * Atomic write that preserves the previous owner and mode. `docker exec`
 * defaults to root; a root-owned users.json would lock the panel (UID 9999)
 * out of its own user store on the next lastLogin/tokenVersion update.
 */
async function writeUsers(data: { users: CliUser[] }): Promise<void> {
  let prevUid: number | null = null;
  let prevGid: number | null = null;
  let prevMode: number | null = null;
  try {
    const st = await stat(USERS_FILE);
    prevUid = st.uid;
    prevGid = st.gid;
    prevMode = st.mode & 0o777;
  } catch {
    // New file: fall back to the data dir's owner (the panel user).
    try {
      const st = await stat(DATA_DIR);
      prevUid = st.uid;
      prevGid = st.gid;
      prevMode = 0o600;
    } catch {
      // Data dir missing — surface that to the caller via writeFile below.
    }
  }

  const tmpFile = `${USERS_FILE}.tmp-${process.pid}`;
  await writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  if (prevMode !== null) await chmod(tmpFile, prevMode).catch(() => {});
  if (prevUid !== null && prevGid !== null && typeof process.getuid === 'function' && process.getuid() === 0) {
    await chown(tmpFile, prevUid, prevGid).catch(() => {});
  }
  await rename(tmpFile, USERS_FILE);
}

function fileExists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJsonIfExists(p: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

// ============== Commands ==============

async function cmdAuthStatus(): Promise<void> {
  console.log('=== KyuubiSoft Panel — Auth Status ===\n');
  console.log(`Data directory:     ${DATA_DIR}`);

  const setupCfg = readJsonIfExists(SETUP_CONFIG_FILE);
  const mainCfg = readJsonIfExists(CONFIG_FILE);
  console.log(`setup-config.json:  ${fileExists(SETUP_CONFIG_FILE) ? 'present' : 'missing'}${setupCfg ? ` (setupComplete: ${setupCfg.setupComplete === true})` : ''}`);
  console.log(`config.json:        ${fileExists(CONFIG_FILE) ? 'present' : 'missing'}${mainCfg ? ` (setupComplete: ${mainCfg.setupComplete === true})` : ''}`);

  const jwtFromConfig = typeof mainCfg?.jwtSecret === 'string' && (mainCfg.jwtSecret as string).length > 0;
  const jwtFromEnv = !!process.env.JWT_SECRET;
  console.log(`JWT secret source:  ${jwtFromConfig ? 'config.json' : jwtFromEnv ? 'environment (JWT_SECRET)' : 'NOT CONFIGURED'}`);

  const demoMode = process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1';
  if (demoMode) {
    console.log('DEMO_MODE:          true (logins use demo/demo and admin/admin unless users.json exists)');
  }

  const usersExist = fileExists(USERS_FILE);
  const envUser = process.env.MANAGER_USERNAME || '';
  const envPwSet = !!process.env.MANAGER_PASSWORD;
  console.log(`users.json:         ${usersExist ? 'present' : 'missing'}`);
  if (usersExist) {
    console.log('Credential source:  users.json — MANAGER_USERNAME/MANAGER_PASSWORD from .env are IGNORED');
    if (envPwSet) {
      console.log('                    (MANAGER_PASSWORD is set in the environment but has NO effect;');
      console.log('                     use "reset-password" below to set a new login password)');
    }
  } else {
    console.log(`Credential source:  environment — first login bootstraps users.json from MANAGER_USERNAME='${envUser || '<unset>'}' / MANAGER_PASSWORD ${envPwSet ? '(set)' : '(NOT SET)'}`);
  }

  const data = await readUsers();
  console.log(`\nUsers (${data.users.length}):`);
  for (const u of data.users) {
    const twoFa = u.totpEnabled ? 'on' : 'off';
    console.log(`  - ${u.username}  role=${u.roleId}  2FA=${twoFa}  lastLogin=${u.lastLogin ?? 'never'}  tokenVersion=${u.tokenVersion ?? 1}`);
  }
  if (data.users.length === 0) {
    console.log('  (none — use "create-admin <username>" to create one)');
  }

  console.log('\nCommands:');
  console.log('  node dist/cli.js reset-password <username> [newPassword]');
  console.log('  node dist/cli.js create-admin <username> [password]');
  console.log('  node dist/cli.js disable-2fa <username>');
}

async function cmdListUsers(): Promise<void> {
  const data = await readUsers();
  if (data.users.length === 0) {
    console.log('No users found in users.json.');
    return;
  }
  for (const u of data.users) {
    console.log(`${u.username}\trole=${u.roleId}\t2FA=${u.totpEnabled ? 'on' : 'off'}\tcreated=${u.createdAt ?? '?'}\tlastLogin=${u.lastLogin ?? 'never'}`);
  }
}

async function cmdResetPassword(username: string | undefined, newPassword: string | undefined, force: boolean): Promise<void> {
  if (!username) {
    console.error('Usage: node dist/cli.js reset-password <username> [newPassword] [--force]');
    process.exit(1);
  }
  const data = await readUsers();
  const user = data.users.find(u => u.username === username);
  if (!user) {
    console.error(`User '${username}' not found. Existing users: ${data.users.map(u => u.username).join(', ') || '(none)'}`);
    console.error(`To create a fresh admin account: node dist/cli.js create-admin ${username}`);
    process.exit(1);
  }

  const generated = !newPassword;
  const password = newPassword ?? generatePassword();
  if (!generated && !force) {
    const policyError = validatePasswordPolicy(password, username);
    if (policyError) {
      console.error(`Rejected: ${policyError} (use --force to override)`);
      process.exit(1);
    }
  }

  user.passwordHash = await bcrypt.hash(password, 12);
  // Invalidate every existing session/refresh token of this account.
  user.tokenVersion = (user.tokenVersion ?? 1) + 1;
  await writeUsers(data);

  console.log(`Password for '${username}' has been reset. All existing sessions were invalidated.`);
  if (generated) {
    console.log(`\n  New password: ${password}\n`);
    console.log('Store it now — it is not shown again. Change it in the panel after login.');
  }
  if (user.totpEnabled) {
    console.log(`Note: 2FA is still ENABLED for this account. If the authenticator is lost, run: node dist/cli.js disable-2fa ${username}`);
  }
}

async function cmdCreateAdmin(username: string | undefined, password: string | undefined): Promise<void> {
  if (!username) {
    console.error('Usage: node dist/cli.js create-admin <username> [password]');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    console.error('Username must be 3-32 characters, alphanumeric with _ or -');
    process.exit(1);
  }
  const data = await readUsers();
  if (data.users.some(u => u.username === username)) {
    console.error(`User '${username}' already exists. Use: node dist/cli.js reset-password ${username}`);
    process.exit(1);
  }

  const generated = !password;
  const pw = password ?? generatePassword();
  const policyError = validatePasswordPolicy(pw, username);
  if (policyError) {
    console.error(`Rejected: ${policyError}`);
    process.exit(1);
  }

  data.users.push({
    username,
    passwordHash: await bcrypt.hash(pw, 12),
    roleId: 'admin',
    createdAt: new Date().toISOString(),
    tokenVersion: 1,
  });
  await writeUsers(data);

  console.log(`Admin user '${username}' created.`);
  if (generated) {
    console.log(`\n  Password: ${pw}\n`);
    console.log('Store it now — it is not shown again. Change it in the panel after login.');
  }
}

async function cmdDisable2fa(username: string | undefined): Promise<void> {
  if (!username) {
    console.error('Usage: node dist/cli.js disable-2fa <username>');
    process.exit(1);
  }
  const data = await readUsers();
  const user = data.users.find(u => u.username === username);
  if (!user) {
    console.error(`User '${username}' not found.`);
    process.exit(1);
  }
  if (!user.totpEnabled && !user.totpSecret && !user.totpPendingSecret) {
    console.log(`2FA is not enabled for '${username}' — nothing to do.`);
    return;
  }
  delete user.totpSecret;
  delete user.totpEnabled;
  delete user.totpPendingSecret;
  delete user.backupCodeHashes;
  delete user.totpLastUsedStep;
  // Kill active sessions too: whoever holds a token now bypassed 2FA.
  user.tokenVersion = (user.tokenVersion ?? 1) + 1;
  await writeUsers(data);
  console.log(`2FA disabled for '${username}'. All existing sessions were invalidated.`);
}

function printHelp(): void {
  console.log(`KyuubiSoft Panel — Admin-Recovery CLI

Usage (inside the manager container):
  docker exec -it <stack>-manager node dist/cli.js <command>

Commands:
  auth-status                                Show setup state, credential source and all users
  list-users                                 List users from users.json
  reset-password <username> [newPassword]    Reset a password (generates a secure one if omitted)
                                             [--force] skips the password policy for a provided password
  create-admin <username> [password]         Create a new admin account
  disable-2fa <username>                     Remove TOTP 2FA from an account (lost authenticator)
  help                                       Show this help

All changes apply immediately — the panel re-reads users.json on every request.
Password resets invalidate the account's existing sessions.`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const args = rest.filter(a => !a.startsWith('--'));
  const force = rest.includes('--force');

  switch (command) {
    case 'auth-status':
    case 'status':
      await cmdAuthStatus();
      break;
    case 'list-users':
    case 'users':
      await cmdListUsers();
      break;
    case 'reset-password':
      await cmdResetPassword(args[0], args[1], force);
      break;
    case 'create-admin':
      await cmdCreateAdmin(args[0], args[1]);
      break;
    case 'disable-2fa':
      await cmdDisable2fa(args[0]);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('CLI failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
