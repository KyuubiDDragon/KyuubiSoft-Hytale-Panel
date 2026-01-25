import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { isDemoMode } from './demoData.js';

// User interface
export interface User {
  username: string;
  passwordHash: string;
  roleId: string;
  createdAt: string;
  lastLogin?: string;
  tokenVersion: number;
}

// Track deleted users for session-based invalidation
const invalidatedUsers = new Set<string>();

export function isUserInvalidated(username: string): boolean {
  return invalidatedUsers.has(username);
}

interface UsersData {
  users: User[];
}

// Path to users file in the persistent data volume
const DATA_DIR = process.env.DATA_PATH || '/app/data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// Ensure data directory exists
async function ensureDataDir(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

// Read users from file
async function readUsers(): Promise<UsersData> {
  try {
    const content = await readFile(USERS_FILE, 'utf-8');
    const data = JSON.parse(content) as UsersData;

    // Migrate users from old role field to new roleId field
    let needsMigration = false;
    for (const user of data.users) {
      const userAny = user as any;
      if (userAny.role !== undefined && userAny.roleId === undefined) {
        userAny.roleId = userAny.role;
        delete userAny.role;
        needsMigration = true;
      }
      // Migrate users without tokenVersion
      if (user.tokenVersion === undefined) {
        user.tokenVersion = 1;
        needsMigration = true;
      }
    }

    // Save migrated data if needed
    if (needsMigration) {
      await writeUsers(data);
    }

    return data;
  } catch {
    // If file doesn't exist, create default admin user from env
    // SECURITY: Use async bcrypt to prevent blocking the event loop
    const passwordHash = await bcrypt.hash(config.managerPassword, 12);
    const defaultAdmin: User = {
      username: config.managerUsername,
      passwordHash,
      roleId: 'admin',
      createdAt: new Date().toISOString(),
      tokenVersion: 1,
    };
    const data: UsersData = { users: [defaultAdmin] };
    await writeUsers(data);
    return data;
  }
}

// Write users to file
async function writeUsers(data: UsersData): Promise<void> {
  await ensureDataDir();
  await writeFile(USERS_FILE, JSON.stringify(data, null, 2), 'utf-8');
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
  return data.users.map(({ passwordHash, ...user }) => user);
}

// Get user by username
export async function getUser(username: string): Promise<User | null> {
  // Demo mode: return demo user data
  if (isDemoMode()) {
    const demoUsers: Record<string, User> = {
      'demo': {
        username: 'demo',
        passwordHash: '',
        roleId: 'viewer',
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        lastLogin: new Date().toISOString(),
        tokenVersion: 1,
      },
      'admin': {
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
  return data.users.find(u => u.username === username) || null;
}

// Verify user credentials
// SECURITY: Use async bcrypt to prevent blocking the event loop
export async function verifyUserCredentials(username: string, password: string): Promise<User | null> {
  // Demo mode: use hardcoded demo credentials
  if (isDemoMode()) {
    const demoCredentials: Record<string, { password: string; roleId: string }> = {
      'demo': { password: 'demo', roleId: 'viewer' },
      'admin': { password: 'admin', roleId: 'admin' },
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
    return null;
  }
  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    return null;
  }
  return user;
}

// Create new user
export async function createUser(
  username: string,
  password: string,
  roleId: string = 'viewer'
): Promise<Omit<User, 'passwordHash'>> {
  const data = await readUsers();

  // Check if username already exists
  if (data.users.some(u => u.username === username)) {
    throw new Error('Username already exists');
  }

  // Validate username format
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    throw new Error('Username must be 3-32 characters, alphanumeric with _ or -');
  }

  // Validate password length
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  // SECURITY: Use async bcrypt to prevent blocking the event loop
  const passwordHash = await bcrypt.hash(password, 12);

  const newUser: User = {
    username,
    passwordHash,
    roleId,
    createdAt: new Date().toISOString(),
    tokenVersion: 1,
  };

  data.users.push(newUser);
  await writeUsers(data);

  const { passwordHash: _, ...userWithoutPassword } = newUser;
  return userWithoutPassword;
}

// Update user
export async function updateUser(
  username: string,
  updates: { password?: string; roleId?: string }
): Promise<Omit<User, 'passwordHash'>> {
  const data = await readUsers();
  const userIndex = data.users.findIndex(u => u.username === username);

  if (userIndex === -1) {
    throw new Error('User not found');
  }

  let shouldInvalidateTokens = false;

  if (updates.password) {
    if (updates.password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    // SECURITY: Use async bcrypt to prevent blocking the event loop
    data.users[userIndex].passwordHash = await bcrypt.hash(updates.password, 12);
    shouldInvalidateTokens = true;
  }

  if (updates.roleId) {
    data.users[userIndex].roleId = updates.roleId;
    shouldInvalidateTokens = true;
  }

  await writeUsers(data);

  // Invalidate tokens after password or role changes
  if (shouldInvalidateTokens) {
    await invalidateUserTokens(username);
  }

  const { passwordHash, ...userWithoutPassword } = data.users[userIndex];
  return userWithoutPassword;
}

// Delete user
export async function deleteUser(username: string): Promise<void> {
  const data = await readUsers();

  // Prevent deleting the last admin
  const adminCount = data.users.filter(u => u.roleId === 'admin').length;
  const userToDelete = data.users.find(u => u.username === username);

  if (!userToDelete) {
    throw new Error('User not found');
  }

  if (userToDelete.roleId === 'admin' && adminCount <= 1) {
    throw new Error('Cannot delete the last admin user');
  }

  // Add to invalidation list before deleting
  invalidatedUsers.add(username);

  data.users = data.users.filter(u => u.username !== username);
  await writeUsers(data);
}

// Update last login time
export async function updateLastLogin(username: string): Promise<void> {
  // Demo mode: no-op (don't persist)
  if (isDemoMode()) {
    return;
  }

  const data = await readUsers();
  const userIndex = data.users.findIndex(u => u.username === username);

  if (userIndex !== -1) {
    data.users[userIndex].lastLogin = new Date().toISOString();
    await writeUsers(data);
  }
}

// Invalidate all tokens for a user by incrementing tokenVersion
export async function invalidateUserTokens(username: string): Promise<void> {
  const data = await readUsers();
  const userIndex = data.users.findIndex(u => u.username === username);

  if (userIndex !== -1) {
    data.users[userIndex].tokenVersion = (data.users[userIndex].tokenVersion || 0) + 1;
    await writeUsers(data);
  }
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

  await readUsers();
}
