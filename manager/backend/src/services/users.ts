import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

// User interface
export interface User {
  username: string;
  passwordHash: string;
  role: 'admin' | 'moderator' | 'operator' | 'viewer';
  createdAt: string;
  lastLogin?: string;
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
    return JSON.parse(content);
  } catch {
    // If file doesn't exist, create default admin user from env
    const defaultAdmin: User = {
      username: config.managerUsername,
      passwordHash: bcrypt.hashSync(config.managerPassword, 12),
      role: 'admin',
      createdAt: new Date().toISOString(),
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
  const data = await readUsers();
  return data.users.map(({ passwordHash, ...user }) => user);
}

// Get user by username
export async function getUser(username: string): Promise<User | null> {
  const data = await readUsers();
  return data.users.find(u => u.username === username) || null;
}

// Verify user credentials
export async function verifyUserCredentials(username: string, password: string): Promise<User | null> {
  const user = await getUser(username);
  if (!user) {
    return null;
  }
  if (!bcrypt.compareSync(password, user.passwordHash)) {
    return null;
  }
  return user;
}

// Create new user
export async function createUser(
  username: string,
  password: string,
  role: User['role'] = 'viewer'
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
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters');
  }

  const newUser: User = {
    username,
    passwordHash: bcrypt.hashSync(password, 12),
    role,
    createdAt: new Date().toISOString(),
  };

  data.users.push(newUser);
  await writeUsers(data);

  const { passwordHash, ...userWithoutPassword } = newUser;
  return userWithoutPassword;
}

// Update user
export async function updateUser(
  username: string,
  updates: { password?: string; role?: User['role'] }
): Promise<Omit<User, 'passwordHash'>> {
  const data = await readUsers();
  const userIndex = data.users.findIndex(u => u.username === username);

  if (userIndex === -1) {
    throw new Error('User not found');
  }

  if (updates.password) {
    if (updates.password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }
    data.users[userIndex].passwordHash = bcrypt.hashSync(updates.password, 12);
  }

  if (updates.role) {
    data.users[userIndex].role = updates.role;
  }

  await writeUsers(data);

  const { passwordHash, ...userWithoutPassword } = data.users[userIndex];
  return userWithoutPassword;
}

// Delete user
export async function deleteUser(username: string): Promise<void> {
  const data = await readUsers();

  // Prevent deleting the last admin
  const adminCount = data.users.filter(u => u.role === 'admin').length;
  const userToDelete = data.users.find(u => u.username === username);

  if (!userToDelete) {
    throw new Error('User not found');
  }

  if (userToDelete.role === 'admin' && adminCount <= 1) {
    throw new Error('Cannot delete the last admin user');
  }

  data.users = data.users.filter(u => u.username !== username);
  await writeUsers(data);
}

// Update last login time
export async function updateLastLogin(username: string): Promise<void> {
  const data = await readUsers();
  const userIndex = data.users.findIndex(u => u.username === username);

  if (userIndex !== -1) {
    data.users[userIndex].lastLogin = new Date().toISOString();
    await writeUsers(data);
  }
}

// Initialize users on startup
export async function initializeUsers(): Promise<void> {
  await readUsers();
}
