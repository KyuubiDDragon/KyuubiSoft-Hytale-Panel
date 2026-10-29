/**
 * Hytale server sign-in (`/auth login device`) of one server: the device code
 * comes from that server's console log, its token files lie in that server's
 * folders, and the panel's record of the flow (hytale-auth.json) lies in its
 * data folder. `serverId` undefined means the default server.
 */
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { execCommand, getLogs } from './docker.js';
import { getServerContext, type ServerContext } from './serverContext.js';
import { readRegularFile, UnsafeFileError } from '../utils/noFollowFs.js';
import { writeJsonAtomic } from '../utils/jsonStore.js';
import { downloaderCredentialsFile, isRegularFileWithin } from '../routes/server/shared.js';
import type { ActionResponse } from '../types/index.js';

export interface HytaleAuthStatus {
  authenticated: boolean;
  deviceCode?: string;
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: number;
  lastChecked?: number;
  persistent?: boolean; // Whether the token is saved to disk or only in memory
  persistenceType?: string; // 'disk' or 'memory'
  serverAuthRequired?: boolean; // True when server shows "No server tokens configured"
  authType?: 'none' | 'downloader' | 'server'; // What type of auth is present
}

export interface HytaleDeviceCodeResponse {
  success: boolean;
  deviceCode?: string;
  userCode?: string;
  verificationUrl?: string;
  expiresIn?: number;
  error?: string;
}

const AUTH_STATUS_FILE = 'hytale-auth.json';
const DEFAULT_DEVICE_CODE_SECONDS = 15 * 60;
const AUTH_STATUS_MAX_BYTES = 64 * 1024;
const CREDENTIALS_MAX_BYTES = 1024 * 1024;

const authStatusFile = (ctx: ServerContext) => path.join(ctx.paths.data, AUTH_STATUS_FILE);

async function readAuthStatus(ctx: ServerContext): Promise<HytaleAuthStatus> {
  try {
    // The data folder belongs to the game server: a planted link is not followed.
    const raw = await readRegularFile(authStatusFile(ctx), [ctx.paths.data], {
      maxBytes: AUTH_STATUS_MAX_BYTES,
    });
    return JSON.parse(raw.toString('utf-8'));
  } catch {
    return { authenticated: false };
  }
}

async function writeAuthStatus(ctx: ServerContext, status: HytaleAuthStatus): Promise<void> {
  try {
    await fs.mkdir(ctx.paths.data, { recursive: true });
    await writeJsonAtomic(authStatusFile(ctx), status);
  } catch (error) {
    logger.error('Failed to save Hytale auth status:', error);
  }
}

/**
 * Reads the Hytale authentication status from disk
 */
export async function getAuthStatus(serverId?: string): Promise<HytaleAuthStatus> {
  return readAuthStatus(await getServerContext(serverId));
}

/**
 * Saves the Hytale authentication status to disk
 */
export async function saveAuthStatus(status: HytaleAuthStatus, serverId?: string): Promise<void> {
  await writeAuthStatus(await getServerContext(serverId), status);
}

/**
 * Sets the persistence type for authentication tokens
 * Available types: Memory, Encrypted
 */
export async function setPersistence(
  type: 'Memory' | 'Encrypted',
  serverId?: string,
): Promise<ActionResponse> {
  try {
    const ctx = await getServerContext(serverId);
    logger.info(`[HytaleAuth] Setting persistence of ${ctx.id} to: ${type}`);

    // Execute the /auth persistence command
    const result = await execCommand(`/auth persistence ${type}`, ctx.id);

    if (!result.success) {
      logger.error('[HytaleAuth] Failed to execute persistence command:', result.error);
      return {
        success: false,
        error: result.error || 'Failed to set persistence type',
      };
    }

    // Wait for the command to execute and for files to be written
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Get logs to verify the change
    const logs = await getLogs(150, ctx.id);
    const cleanLogs = stripAnsiCodes(logs);

    // Debug logging removed to reduce console spam

    // Check if persistence was set successfully - look for success messages
    const successPatterns = [
      /persistence.*(?:set|changed|enabled|configured).*encrypted/i,
      /encrypted.*persistence.*(?:enabled|active|set)/i,
      /credentials.*(?:will be|are now).*(?:saved|stored|persisted)/i,
      /persistence.*type.*encrypted/i,
    ];

    const hasSuccess = successPatterns.some((pattern) => pattern.test(cleanLogs));

    // Also check if there are still memory-only warnings
    const hasMemoryWarning = /credentials stored in memory only/i.test(cleanLogs);

    if (hasSuccess && !hasMemoryWarning) {
      logger.info('[HytaleAuth] Persistence successfully set to Encrypted');

      // Check if token file now exists
      const tokenFileExists = await checkTokenFileExists(ctx);

      // Update auth status
      const status = await readAuthStatus(ctx);
      await writeAuthStatus(ctx, {
        ...status,
        persistent: type === 'Encrypted',
        persistenceType: type === 'Encrypted' ? 'disk' : 'memory',
        lastChecked: Date.now(),
      });

      return {
        success: true,
        message: `Persistence type set to ${type}. Token file exists: ${tokenFileExists}`,
      };
    }

    // If we still see memory warnings, it didn't work
    if (hasMemoryWarning) {
      logger.warn(
        '[HytaleAuth] Persistence command executed but still seeing memory-only warnings',
      );
      return {
        success: false,
        error:
          'Persistence command executed but credentials are still in memory only. The server may not support encrypted persistence yet.',
      };
    }

    logger.warn('[HytaleAuth] Could not verify persistence type change from logs');
    return {
      success: false,
      error: 'Could not verify persistence type change. Check server logs for details.',
    };
  } catch (error) {
    logger.error('Failed to set persistence:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Removes ANSI escape codes from text
 */
function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Initiates the device code flow by executing /auth login device
 * Parses the server console output to extract the device code and verification URL
 * Note: Persistence is set AFTER successful authentication (per Hytale documentation)
 */
export async function initiateDeviceLogin(serverId?: string): Promise<HytaleDeviceCodeResponse> {
  try {
    const ctx = await getServerContext(serverId);
    // Execute the auth command
    const result = await execCommand('/auth login device', ctx.id);

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Failed to execute auth command',
      };
    }

    // Wait a bit for the server to output the device code
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get recent logs to find the device code and URL
    const logs = await getLogs(50, ctx.id);

    // Remove ANSI escape codes from logs
    const cleanLogs = stripAnsiCodes(logs);

    // Parse logs to extract device code information
    // Hytale server output format (may vary between versions):
    // "Visit: https://oauth.accounts.hytale.com/oauth2/device/verify"
    // "Enter code: fHmkjxFE"
    // "Or visit: https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=fHmkjxFE"

    // First, try to get the complete URL with user_code parameter (preferred)
    const completeUrlMatch = cleanLogs.match(
      /(https?:\/\/oauth\.accounts\.hytale\.com\/[^\s]*\?user_code=[a-zA-Z0-9]+)/i,
    );

    // Fallback: get any oauth URL
    const basicUrlMatch = cleanLogs.match(/(https?:\/\/oauth\.accounts\.hytale\.com\/[^\s?]+)/i);

    // Get the code - try multiple patterns (Enter code, Authorization code, etc.)
    const codeMatch = cleanLogs.match(/(?:enter|authorization)\s+code:\s*([a-zA-Z0-9]+)/i);

    // Use complete URL if available, otherwise use basic URL
    let verificationUrl = completeUrlMatch
      ? completeUrlMatch[1].trim()
      : basicUrlMatch
        ? basicUrlMatch[1].trim()
        : null;
    const userCode = codeMatch ? codeMatch[1].trim() : null;

    // If we only have basic URL, try to extract code from URL or use authorization code
    if (verificationUrl && !verificationUrl.includes('user_code=') && userCode) {
      verificationUrl += `?user_code=${userCode}`;
    }

    if (!verificationUrl || !userCode) {
      logger.error('[HytaleAuth] Could not parse auth response from server logs');
      return {
        success: false,
        error:
          'Could not parse authentication response from server logs. Make sure the server is running.',
      };
    }

    const deviceCode = userCode; // Use userCode as deviceCode

    // The server says how long the code lives ("Waiting for authorization
    // (expires in 599 seconds)"); without that line, 15 minutes as before.
    const announced = Number([...cleanLogs.matchAll(/expires in (\d{1,5}) seconds/gi)].pop()?.[1]);
    const expiresIn =
      Number.isInteger(announced) && announced > 0 ? announced : DEFAULT_DEVICE_CODE_SECONDS;
    const expiresAt = Date.now() + expiresIn * 1000;
    await writeAuthStatus(ctx, {
      authenticated: false,
      deviceCode,
      userCode,
      verificationUrl,
      expiresAt,
      lastChecked: Date.now(),
    });

    return {
      success: true,
      deviceCode,
      userCode,
      verificationUrl,
      expiresIn,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * The folders a server keeps its sign-in in: its auth folder (/opt/hytale/auth
 * in the container) and the auth folders inside its server folder.
 */
function authDirs(ctx: ServerContext): string[] {
  return [
    ctx.paths.auth,
    path.join(ctx.paths.server, 'auth'),
    path.join(ctx.paths.server, '.auth'),
  ];
}

/**
 * Lists all files in the auth directories
 * Checks the server's auth folder and server/auth, server/.auth
 */
export async function listAuthFiles(serverId?: string): Promise<string[]> {
  return listAuthFilesOf(await getServerContext(serverId));
}

async function listAuthFilesOf(ctx: ServerContext): Promise<string[]> {
  const allFiles: string[] = [];

  for (const authDir of authDirs(ctx)) {
    // The game server can write here: a folder replaced by a link is not
    // listed, and only regular files count.
    const st = await fs.lstat(authDir).catch(() => null);
    if (!st?.isDirectory()) continue;
    try {
      const entries = await fs.readdir(authDir, { withFileTypes: true });
      allFiles.push(...entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    } catch {
      // Directory doesn't exist, continue
    }
  }

  // No logging needed for empty auth directories

  return allFiles;
}

/**
 * Reads and returns the structure of the downloader credentials file
 * This helps understand what format the credentials are in
 */
export async function inspectDownloaderCredentials(serverId?: string): Promise<{
  exists: boolean;
  structure?: any;
  error?: string;
}> {
  try {
    const { file, dir } = downloaderCredentialsFile(await getServerContext(serverId));

    try {
      // The downloader folder belongs to the game server: a link is not followed.
      const content = (
        await readRegularFile(file, [dir], { maxBytes: CREDENTIALS_MAX_BYTES })
      ).toString('utf-8');
      const parsed = JSON.parse(content);

      // Return structure without exposing sensitive values
      const structure = Object.keys(parsed).reduce((acc, key) => {
        const value = parsed[key];
        if (typeof value === 'string') {
          acc[key] = `<string of length ${value.length}>`;
        } else if (typeof value === 'number') {
          acc[key] = `<number: ${value}>`;
        } else if (typeof value === 'object' && value !== null) {
          acc[key] = `<object with ${Object.keys(value).length} keys>`;
        } else {
          acc[key] = `<${typeof value}>`;
        }
        return acc;
      }, {} as any);

      // Credentials structure inspected

      return {
        exists: true,
        structure,
      };
    } catch (readError) {
      // Downloader credentials not found or not readable
      return {
        exists: false,
        error:
          readError instanceof UnsafeFileError
            ? readError.message
            : 'File not found or not readable',
      };
    }
  } catch (error) {
    logger.error('[HytaleAuth] Error inspecting downloader credentials:', error);
    return {
      exists: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/** Throws unless `file` is a regular file in the server's folders (no planted link). */
async function requireTokenFile(ctx: ServerContext, file: string): Promise<void> {
  if (!(await isRegularFileWithin(file, [ctx.paths.auth, ctx.paths.server]))) {
    throw new Error(`No token file at ${file}`);
  }
}

/**
 * Checks if the server has a saved authentication token file
 * Common locations: server folder, config folder, or home directory
 */
async function checkTokenFileExists(ctx: ServerContext): Promise<boolean> {
  try {
    // First, list what's in the auth directory
    const authFiles = await listAuthFilesOf(ctx);
    const serverPath = ctx.paths.server;

    // Try common token file locations
    const possiblePaths = [
      // The server's auth folder (/opt/hytale/auth, same level as server)
      path.join(ctx.paths.auth, 'credentials.enc'),
      path.join(ctx.paths.auth, 'auth.enc'),
      path.join(ctx.paths.auth, 'token'),
      path.join(ctx.paths.auth, 'oauth_token'),
      // Root server folder
      path.join(serverPath, 'auth.enc'),
      path.join(serverPath, '.hytale_token'),
      path.join(serverPath, 'auth_token'),
      path.join(serverPath, 'oauth_token.json'),
      path.join(serverPath, 'oauth_credentials.json'),
      path.join(serverPath, '.oauth_token'),
      // Config folder
      path.join(serverPath, 'config', 'auth_token'),
      path.join(serverPath, 'config', 'oauth_token.json'),
      // 'auth' subfolder in server
      path.join(serverPath, 'auth', 'credentials.json'),
      path.join(serverPath, 'auth', 'oauth_credentials.json'),
      path.join(serverPath, 'auth', 'credentials.enc'),
      path.join(serverPath, 'auth', 'auth.enc'),
      // '.auth' subfolder in server
      path.join(serverPath, '.auth', 'credentials.json'),
      path.join(serverPath, '.auth', 'oauth_credentials.json'),
      path.join(serverPath, '.auth', 'credentials.enc'),
      path.join(serverPath, '.auth', 'auth.enc'),
    ];

    for (const tokenPath of possiblePaths) {
      try {
        await requireTokenFile(ctx, tokenPath);
        // File exists
        logger.info(`[HytaleAuth] Found Hytale auth token at: ${tokenPath}`);
        return true;
      } catch {
        // File doesn't exist, try next
        continue;
      }
    }

    // If we have ANY files in the .auth directory, consider it as having tokens
    if (authFiles.length > 0) {
      logger.info(
        `[HytaleAuth] Found ${authFiles.length} file(s) in .auth directory, considering as authenticated`,
      );
      return true;
    }

    return false;
  } catch (error) {
    logger.error('[HytaleAuth] Error checking token file:', error);
    return false;
  }
}

/**
 * Checks if the authentication has been completed by the user
 * Checks for real server auth tokens (auth.enc), not downloader credentials
 * If authentication is successful but not persisted, automatically runs /auth persistence Encrypted
 */
export async function checkAuthCompletion(serverId?: string): Promise<ActionResponse> {
  try {
    const ctx = await getServerContext(serverId);
    const status = await readAuthStatus(ctx);

    // Check for REAL server token files (auth.enc)
    // These are created by /auth persistence Encrypted AFTER successful auth
    const serverTokenPaths = [
      path.join(ctx.paths.auth, 'auth.enc'),
      path.join(ctx.paths.server, '.auth', 'auth.enc'),
      path.join(ctx.paths.server, 'auth.enc'),
    ];

    for (const tokenPath of serverTokenPaths) {
      try {
        await requireTokenFile(ctx, tokenPath);
        logger.info(`[HytaleAuth] Found server auth token at: ${tokenPath}`);
        await writeAuthStatus(ctx, {
          authenticated: true,
          persistent: true,
          persistenceType: 'disk',
          lastChecked: Date.now(),
        });
        return {
          success: true,
          message: 'Server is authenticated.',
        };
      } catch {
        // File doesn't exist, continue
      }
    }

    // If there's a pending device code, check if authentication completed
    if (status.deviceCode) {
      if (status.expiresAt && Date.now() > status.expiresAt) {
        await writeAuthStatus(ctx, { authenticated: false });
        return {
          success: false,
          error: 'Authentication code has expired. Please initiate login again.',
        };
      }

      // Check server logs for authentication success
      const logs = await getLogs(100, ctx.id);
      const cleanLogs = stripAnsiCodes(logs);

      // Look for success messages: "Authentication successful" or "Successfully created game session"
      const authSuccessPatterns = [
        /authentication\s+successful/i,
        /successfully\s+created\s+game\s+session/i,
        /logged\s+in\s+successfully/i,
      ];

      const isAuthSuccessful = authSuccessPatterns.some((pattern) => pattern.test(cleanLogs));

      if (isAuthSuccessful) {
        logger.info(
          '[HytaleAuth] Authentication successful detected in logs! Setting persistence...',
        );

        // Authentication successful - now set persistence to save credentials
        const persistenceResult = await execCommand('/auth persistence Encrypted', ctx.id);

        if (persistenceResult.success) {
          // Wait for the persistence command to create auth.enc
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Verify auth.enc was created
          for (const tokenPath of serverTokenPaths) {
            try {
              await requireTokenFile(ctx, tokenPath);
              logger.info(
                `[HytaleAuth] Persistence successful - auth.enc created at: ${tokenPath}`,
              );
              await writeAuthStatus(ctx, {
                authenticated: true,
                persistent: true,
                persistenceType: 'disk',
                lastChecked: Date.now(),
              });
              return {
                success: true,
                message: 'Server is authenticated and credentials saved to disk.',
              };
            } catch {
              // Continue checking
            }
          }

          // auth.enc not found but persistence command succeeded - auth is in memory
          logger.info(
            '[HytaleAuth] Persistence command ran but auth.enc not found. Auth may be memory-only.',
          );
          await writeAuthStatus(ctx, {
            authenticated: true,
            persistent: false,
            persistenceType: 'memory',
            lastChecked: Date.now(),
          });
          return {
            success: true,
            message:
              'Server is authenticated (memory only - credentials may not persist after restart).',
          };
        } else {
          logger.warn('[HytaleAuth] Failed to set persistence:', persistenceResult.error);
          // Auth successful but persistence failed
          await writeAuthStatus(ctx, {
            authenticated: true,
            persistent: false,
            persistenceType: 'memory',
            lastChecked: Date.now(),
          });
          return {
            success: true,
            message:
              'Server is authenticated but persistence failed. Credentials will be lost on restart.',
          };
        }
      }

      return {
        success: false,
        error:
          'Authentication not yet completed. Please complete the authentication in your browser.',
      };
    }

    // Check saved status (for memory-only auth)
    if (status.authenticated) {
      return {
        success: true,
        message:
          'Server appears to be authenticated (memory only - will need re-auth after restart).',
      };
    }

    // Check logs for "No server tokens configured" - indicates server needs auth after download
    const logs = await getLogs(200, ctx.id);
    const cleanLogs = stripAnsiCodes(logs);

    const serverAuthNeeded = /no server tokens configured/i.test(cleanLogs);

    // Check if downloader credentials exist (meaning download auth was done)
    const downloaderCredsExist = await checkDownloaderCredentialsExist(ctx);

    if (serverAuthNeeded) {
      logger.info(
        '[HytaleAuth] Server requires authentication (detected "No server tokens configured")',
      );

      // Update status to indicate server auth is specifically required
      await writeAuthStatus(ctx, {
        authenticated: false,
        serverAuthRequired: true,
        authType: downloaderCredsExist ? 'downloader' : 'none',
        lastChecked: Date.now(),
      });

      return {
        success: false,
        error: downloaderCredsExist
          ? 'Download complete. Server requires separate authentication. Click "Initiate Auth" to authenticate the server.'
          : 'Server requires authentication. Click "Initiate Auth" to start device login.',
      };
    }

    // Not authenticated
    return {
      success: false,
      error: 'Server requires authentication. Click "Initiate Auth" to start device login.',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Checks if downloader credentials exist (separate from server auth)
 */
async function checkDownloaderCredentialsExist(ctx: ServerContext): Promise<boolean> {
  const { file, dir } = downloaderCredentialsFile(ctx);
  return isRegularFileWithin(file, [dir]);
}

/**
 * Resets the authentication status (for logout or retry)
 */
export async function resetAuth(serverId?: string): Promise<ActionResponse> {
  try {
    await writeAuthStatus(await getServerContext(serverId), { authenticated: false });
    return {
      success: true,
      message: 'Authentication status reset',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset auth status',
    };
  }
}
