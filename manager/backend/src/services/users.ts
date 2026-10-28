import { access, mkdir } from 'fs/promises';
import path from 'path';
import bcrypt from 'bcrypt';
import { config } from '../config.js';
import { isDemoMode } from './demoData.js';
import { readJsonFile, updateJsonFile } from '../utils/jsonStore.js';

// Shared password policy. Applied at every entry point that mints or
// changes a password: createUser / updateUser (API) and the setup wizard's
// admin-account step. Returns null on success or a human-readable reason.
const COMMON_SEQUENCES = ['password', 'changeme', '123456789012', 'qwertyuiop', 'administrator'];
export function validatePasswordPolicy(password: string, username?: string): string | null {
  if (typeof password !== 'string' || password.length < 12) {
    return 'Password must be at least 12 characters';
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((rx) =>
    rx.test(password),
  ).length;
  if (classes < 3) {
    return 'Password must include at least three of: lowercase, uppercase, digit, symbol';
  }
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return 'Password must not contain the username';
  }
  if (COMMON_SEQUENCES.some((c) => password.toLowerCase().includes(c))) {
    return 'Password contains a well-known sequence; pick something less guessable';
  }
  return null;
}

// User interface
export interface User {
  username: string;
  passwordHash: string;
  roleId: string;
  createdAt: string;
  lastLogin?: string;
  tokenVersion: number;
  /** Servers the account may use. Absent = every server, [] = none. Admins ('*') ignore it. */
  allowedServers?: string[];
}

/**
 * The servers an account is limited to, or null when it may use every server.
 * Fails closed: a missing account or a value that is not a list of ids
 * (hand-edited or damaged users.json) limits it to no server at all.
 */
export function allowedServersOf(
  user: Pick<User, 'username' | 'allowedServers'> | null,
): string[] | null {
  if (!user) return [];
  const value = (user as { allowedServers?: unknown }).allowedServers;
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.every((id) => typeof id === 'string')) {
    return [...new Set(value as string[])];
  }
  console.error(
    `[Users] allowedServers of "${user.username}" is not a list of server ids; treating it as no server`,
  );
  return [];
}

/**
 * The account fields the API hands out. users.json also holds other modules'
 * per-user data (2FA secrets, backup-code hashes, SSO links); none of it may
 * leave this module through a user listing or an update reply.
 */
function toPublicUser(user: User): Omit<User, 'passwordHash'> {
  const publicUser: Omit<User, 'passwordHash'> = {
    username: user.username,
    roleId: user.roleId,
    createdAt: user.createdAt,
    tokenVersion: user.tokenVersion,
  };
  if (user.lastLogin !== undefined) publicUser.lastLogin = user.lastLogin;
  const allowed = allowedServersOf(user);
  if (allowed !== null) publicUser.allowedServers = allowed;
  return publicUser;
}

// A valid bcrypt hash compared against when the supplied username doesn't
// exist, so "no such user" costs the same time as "wrong password". Without
// this, a missing account returns instantly (no bcrypt) and leaks via timing
// which usernames are valid. Computed once at startup.
const TIMING_DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 12);

// Track deleted users for session-based invalidation
const invalidatedUsers = new Set<string>();

export function isUserInvalidated(username: string): boolean {
  return invalidatedUsers.has(username);
}

interface UsersData {
  users: User[];
}

// Path to users file in the persistent data volume
const DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// users.json is read on every authenticated request and rewritten on every
// login, by this module, the 2FA service and SSO. Two rules keep it intact:
//  - Only a MISSING file is bootstrapped. A corrupt or unreadable one throws
//    (the request fails with 500) and is never replaced — replacing it with
//    the env admin used to wipe every other account and its 2FA.
//  - Every write goes through updateUsers(): serialised read-modify-write
//    with an atomic tmp → fsync → rename.
const hasUsersArray = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { users?: unknown }).users);

/**
 * Raw users.json content for modules that keep extra per-user fields (2FA,
 * SSO links). Null only when the file does not exist; throws when corrupt.
 */
export async function readUsersFile<
  T extends { users: unknown[] } = UsersData,
>(): Promise<T | null> {
  return readJsonFile<T>(USERS_FILE, { isValid: hasUsersArray });
}

// Bring legacy records up to date in place. Returns true if anything changed.
function migrateUserRecords(data: UsersData): boolean {
  let changed = false;
  for (const user of data.users) {
    const userAny = user as any;
    // Migrate users from old role field to new roleId field
    if (userAny.role !== undefined && userAny.roleId === undefined) {
      userAny.roleId = userAny.role;
      delete userAny.role;
      changed = true;
    }
    // Migrate users without tokenVersion
    if (user.tokenVersion === undefined) {
      user.tokenVersion = 1;
      changed = true;
    }
  }
  return changed;
}

// Create users.json with the env admin. Called only when the file does not
// exist; re-checked under the lock so concurrent first requests create it once.
async function bootstrapUsers(): Promise<UsersData> {
  // Only when BOTH env vars are actually set. Minting a user with an empty
  // username/password (e.g. post-setup installs that removed
  // MANAGER_PASSWORD from .env, then lost their users.json) would create a
  // broken account record instead of surfacing the real problem.
  if (!config.managerUsername || !config.managerPassword) {
    console.error(
      '[Users] users.json is missing and MANAGER_USERNAME/MANAGER_PASSWORD are not set — ' +
        'no login is possible. Recover with: docker exec -it <manager-container> node dist/cli.js reset-password <username>',
    );
    return { users: [] };
  }
  // SECURITY: Use async bcrypt to prevent blocking the event loop
  const passwordHash = await bcrypt.hash(config.managerPassword, 12);
  await mkdir(DATA_DIR, { recursive: true });
  let created = false;
  const data = await updateJsonFile<UsersData>(
    USERS_FILE,
    (current) => {
      if (current) return undefined;
      created = true;
      return {
        users: [
          {
            username: config.managerUsername,
            passwordHash,
            roleId: 'admin',
            createdAt: new Date().toISOString(),
            tokenVersion: 1,
          },
        ],
      };
    },
    { isValid: hasUsersArray },
  );
  if (created) {
    console.log(
      `[Users] Created users.json with admin '${config.managerUsername}' from MANAGER_USERNAME/MANAGER_PASSWORD`,
    );
  }
  return data ?? { users: [] };
}

// Read users from file (bootstraps a missing file, migrates legacy records)
async function readUsers(): Promise<UsersData> {
  const data = await readUsersFile();
  if (!data) return bootstrapUsers();
  if (migrateUserRecords(data)) {
    // Persist under the lock, re-applied to the file's current content so a
    // concurrent change is not lost.
    await updateJsonFile<UsersData>(
      USERS_FILE,
      (current) => (current && migrateUserRecords(current) ? current : undefined),
      { isValid: hasUsersArray },
    );
  }
  return data;
}

/**
 * Serialised read-modify-write of users.json. `mutate` changes `data` in
 * place; return false to skip the write, throw to abort. Resolves to the
 * content after the update. A file that vanished after bootstrap is not
 * recreated with a partial account list.
 */
export async function updateUsers<T extends { users: unknown[] } = UsersData>(
  mutate: (data: T) => boolean | void,
): Promise<T> {
  await readUsers();
  const result = await updateJsonFile<T>(
    USERS_FILE,
    (current) => {
      if (!current) throw new Error('users.json is missing');
      return mutate(current) === false ? undefined : current;
    },
    { isValid: hasUsersArray },
  );
  return result!;
}

function findUserIndex(data: UsersData, username: string): number {
  return data.users.findIndex((u) => u.username === username);
}

// Get all users (without password hashes)
export async function getAllUsers(): Promise<Omit<User, 'passwordHash'>[]> {
  // Demo mode: return demo users
  if (isDemoMode()) {
    return [
      {
        username: 'admin',
        roleId: 'admin',
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        lastLogin: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        tokenVersion: 1,
      },
      {
        username: 'demo',
        roleId: 'viewer',
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        lastLogin: new Date().toISOString(),
        tokenVersion: 1,
      },
    ];
  }

  const data = await readUsers();
  return data.users.map(toPublicUser);
}

// Get user by username
export async function getUser(username: string): Promise<User | null> {
  // Demo mode: return demo user data
  if (isDemoMode()) {
    const demoUsers: Record<string, User> = {
      demo: {
        username: 'demo',
        passwordHash: '',
        roleId: 'viewer',
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        lastLogin: new Date().toISOString(),
        tokenVersion: 1,
      },
      admin: {
        username: 'admin',
        passwordHash: '',
        roleId: 'admin',
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        lastLogin: new Date().toISOString(),
        tokenVersion: 1,
      },
    };
    return demoUsers[username.toLowerCase()] || null;
  }

  const data = await readUsers();
  return data.users.find((u) => u.username === username) || null;
}

// Verify user credentials
// SECURITY: Use async bcrypt to prevent blocking the event loop
export async function verifyUserCredentials(
  username: string,
  password: string,
): Promise<User | null> {
  // Demo mode: use hardcoded demo credentials
  if (isDemoMode()) {
    const demoCredentials: Record<string, { password: string; roleId: string }> = {
      demo: { password: 'demo', roleId: 'viewer' },
      admin: { password: 'admin', roleId: 'admin' },
    };

    const cred = demoCredentials[username.toLowerCase()];
    if (cred && password === cred.password) {
      return {
        username: username.toLowerCase(),
        passwordHash: '', // Not needed for demo
        roleId: cred.roleId,
        createdAt: new Date().toISOString(),
        tokenVersion: 1,
      };
    }
    return null;
  }

  const user = await getUser(username);
  if (!user) {
    // Constant-time: still run a bcrypt comparison so a missing account is
    // indistinguishable from a wrong password by response timing.
    await bcrypt.compare(password, TIMING_DUMMY_HASH);
    return null;
  }
  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    return null;
  }
  return user;
}

/** Accounts only get roles that exist; anything else would break every rights lookup. */
async function assertKnownRole(roleId: unknown): Promise<void> {
  if (typeof roleId !== 'string' || roleId === '') throw new Error('roleId must be a role id');
  // roles.ts imports this module; importing it lazily keeps the cycle out of load time.
  const { roleExists } = await import('./roles.js');
  if (!(await roleExists(roleId))) throw new Error(`Unknown role: ${roleId}`);
}

// Create new user
export async function createUser(
  username: string,
  password: string,
  roleId: string = 'viewer',
  allowedServers: string[] | null = null,
): Promise<Omit<User, 'passwordHash'>> {
  const data = await readUsers();

  // Check if username already exists (re-checked under the lock below)
  if (data.users.some((u) => u.username === username)) {
    throw new Error('Username already exists');
  }

  // Validate username format
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    throw new Error('Username must be 3-32 characters, alphanumeric with _ or -');
  }

  // Validate password against the shared policy (length + character classes
  // + username/common-sequence checks). The setup wizard runs the same
  // policy so accounts created via either route are held to the same bar.
  const policyError = validatePasswordPolicy(password, username);
  if (policyError) {
    throw new Error(policyError);
  }
  await assertKnownRole(roleId);

  // SECURITY: Use async bcrypt to prevent blocking the event loop
  const passwordHash = await bcrypt.hash(password, 12);

  const newUser: User = {
    username,
    passwordHash,
    roleId,
    createdAt: new Date().toISOString(),
    tokenVersion: 1,
    // Written with the account, so it never exists without its list.
    ...(allowedServers === null ? {} : { allowedServers: [...new Set(allowedServers)] }),
  };

  await updateUsers((current) => {
    if (current.users.some((u) => u.username === username)) {
      throw new Error('Username already exists');
    }
    current.users.push(newUser);
  });

  return toPublicUser(newUser);
}

// Update user
export async function updateUser(
  username: string,
  updates: { password?: string; roleId?: string },
): Promise<Omit<User, 'passwordHash'>> {
  const data = await readUsers();
  if (findUserIndex(data, username) === -1) {
    throw new Error('User not found');
  }
  if (updates.roleId) await assertKnownRole(updates.roleId);

  // Hash outside the lock: bcrypt takes ~250 ms and would stall every other
  // users.json write (logins, 2FA) meanwhile.
  let passwordHash: string | undefined;
  if (updates.password) {
    const policyError = validatePasswordPolicy(updates.password, username);
    if (policyError) {
      throw new Error(policyError);
    }
    // SECURITY: Use async bcrypt to prevent blocking the event loop
    passwordHash = await bcrypt.hash(updates.password, 12);
  }

  let updated: User | undefined;
  await updateUsers((current) => {
    const userIndex = findUserIndex(current, username);
    if (userIndex === -1) {
      throw new Error('User not found');
    }
    const user = current.users[userIndex];
    if (passwordHash) {
      user.passwordHash = passwordHash;
    }
    if (updates.roleId) {
      user.roleId = updates.roleId;
    }
    // Invalidate tokens after password or role changes (same write)
    if (passwordHash || updates.roleId) {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }
    updated = user;
  });

  return toPublicUser(updated!);
}

/**
 * Set (list) or clear (null = every server) the servers an account may use.
 * Sessions stay valid: every request reads the list from users.json again.
 */
export async function setUserAllowedServers(
  username: string,
  serverIds: string[] | null,
): Promise<Omit<User, 'passwordHash'>> {
  let updated: User | undefined;
  await updateUsers((current) => {
    const user = current.users.find((u) => u.username === username);
    if (!user) throw new Error('User not found');
    if (serverIds === null) delete user.allowedServers;
    else user.allowedServers = [...new Set(serverIds)];
    updated = user;
  });
  return toPublicUser(updated!);
}

/** Take a deleted server off every account's list. Returns how many lists changed. */
export async function removeServerFromAllowedLists(serverId: string): Promise<number> {
  let changed = 0;
  await updateUsers((current) => {
    for (const user of current.users) {
      const list = user.allowedServers;
      if (!Array.isArray(list) || !list.includes(serverId)) continue;
      user.allowedServers = list.filter((id) => id !== serverId);
      changed++;
    }
    return changed > 0;
  });
  return changed;
}

// Delete user
export async function deleteUser(username: string): Promise<void> {
  await updateUsers((current) => {
    // Prevent deleting the last admin
    const adminCount = current.users.filter((u) => u.roleId === 'admin').length;
    const userToDelete = current.users.find((u) => u.username === username);

    if (!userToDelete) {
      throw new Error('User not found');
    }

    if (userToDelete.roleId === 'admin' && adminCount <= 1) {
      throw new Error('Cannot delete the last admin user');
    }

    // Add to invalidation list before deleting
    invalidatedUsers.add(username);

    current.users = current.users.filter((u) => u.username !== username);
  });
}

// Update last login time
export async function updateLastLogin(username: string): Promise<void> {
  // Demo mode: no-op (don't persist)
  if (isDemoMode()) {
    return;
  }

  await updateUsers((current) => {
    const userIndex = findUserIndex(current, username);
    if (userIndex === -1) return false;
    current.users[userIndex].lastLogin = new Date().toISOString();
  });
}

// Invalidate all tokens for a user by incrementing tokenVersion
export async function invalidateUserTokens(username: string): Promise<void> {
  await updateUsers((current) => {
    const userIndex = findUserIndex(current, username);
    if (userIndex === -1) return false;
    current.users[userIndex].tokenVersion = (current.users[userIndex].tokenVersion || 0) + 1;
  });
}

// Get current token version for a user
export async function getTokenVersion(username: string): Promise<number> {
  // Demo mode: always return 1 (no token invalidation tracking)
  if (isDemoMode()) {
    return 1;
  }

  const user = await getUser(username);
  return user?.tokenVersion ?? 1;
}

// Initialize users on startup
export async function initializeUsers(): Promise<void> {
  // Demo mode: no initialization needed
  if (isDemoMode()) {
    console.log('[Users] Demo mode - using in-memory demo users');
    return;
  }

  // Make the active credential source explicit at startup. The single most
  // common support case is an operator changing MANAGER_PASSWORD in .env and
  // expecting it to take effect — it never does once users.json exists.
  let usersFileExists = false;
  try {
    await access(USERS_FILE);
    usersFileExists = true;
  } catch {
    // not created yet
  }
  if (usersFileExists && config.managerPassword) {
    console.log(
      '[Users] users.json exists — logins are validated against it. ' +
        'MANAGER_USERNAME/MANAGER_PASSWORD from the environment are IGNORED. ' +
        'To reset a password run: docker exec -it <manager-container> node dist/cli.js reset-password <username>',
    );
  }

  await readUsers();
}
