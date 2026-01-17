import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { execCommand, getLogs } from './docker.js';
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
}

export interface HytaleDeviceCodeResponse {
  success: boolean;
  deviceCode?: string;
  userCode?: string;
  verificationUrl?: string;
  expiresIn?: number;
  error?: string;
}

const AUTH_STATUS_FILE = path.join(config.dataPath, 'hytale-auth.json');

/**
 * Reads the Hytale authentication status from disk
 */
export async function getAuthStatus(): Promise<HytaleAuthStatus> {
  try {
    const data = await fs.readFile(AUTH_STATUS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { authenticated: false };
  }
}

/**
 * Saves the Hytale authentication status to disk
 */
export async function saveAuthStatus(status: HytaleAuthStatus): Promise<void> {
  try {
    await fs.mkdir(config.dataPath, { recursive: true });
    await fs.writeFile(AUTH_STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (error) {
    console.error('Failed to save Hytale auth status:', error);
  }
}

/**
 * Sets the persistence type for authentication tokens
 * Available types: Memory, Encrypted
 */
export async function setPersistence(type: 'Memory' | 'Encrypted'): Promise<ActionResponse> {
  try {
    console.log(`[HytaleAuth] Setting persistence to: ${type}`);

    // Execute the /auth persistence command
    const result = await execCommand(`/auth persistence ${type}`);

    if (!result.success) {
      console.error('[HytaleAuth] Failed to execute persistence command:', result.error);
      return {
        success: false,
        error: result.error || 'Failed to set persistence type',
      };
    }

    // Wait for the command to execute and for files to be written
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Get logs to verify the change
    const logs = await getLogs(150);
    const cleanLogs = stripAnsiCodes(logs);

    console.log('[HytaleAuth] Logs after persistence command:', cleanLogs.substring(cleanLogs.length - 500));

    // Check if persistence was set successfully - look for success messages
    const successPatterns = [
      /persistence.*(?:set|changed|enabled|configured).*encrypted/i,
      /encrypted.*persistence.*(?:enabled|active|set)/i,
      /credentials.*(?:will be|are now).*(?:saved|stored|persisted)/i,
      /persistence.*type.*encrypted/i
    ];

    const hasSuccess = successPatterns.some(pattern => pattern.test(cleanLogs));

    // Also check if there are still memory-only warnings
    const hasMemoryWarning = /credentials stored in memory only/i.test(cleanLogs);

    if (hasSuccess && !hasMemoryWarning) {
      console.log('[HytaleAuth] Persistence successfully set to Encrypted');

      // Check if token file now exists
      const tokenFileExists = await checkTokenFileExists();

      // Update auth status
      const status = await getAuthStatus();
      await saveAuthStatus({
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
      console.warn('[HytaleAuth] Persistence command executed but still seeing memory-only warnings');
      return {
        success: false,
        error: 'Persistence command executed but credentials are still in memory only. The server may not support encrypted persistence yet.',
      };
    }

    console.warn('[HytaleAuth] Could not verify persistence type change from logs');
    return {
      success: false,
      error: 'Could not verify persistence type change. Check server logs for details.',
    };
  } catch (error) {
    console.error('Failed to set persistence:', error);
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
 */
export async function initiateDeviceLogin(): Promise<HytaleDeviceCodeResponse> {
  try {
    // Execute the auth command
    const result = await execCommand('/auth login device');

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Failed to execute auth command',
      };
    }

    // Wait a bit for the server to output the device code
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get recent logs to find the device code and URL
    const logs = await getLogs(50);

    // Remove ANSI escape codes from logs
    const cleanLogs = stripAnsiCodes(logs);

    // Parse logs to extract device code information
    // Hytale server output format:
    // "Please visit the following URL to authenticate:"
    // "https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=XXXXXX"
    // "Or visit the following URL and enter the code:"
    // "https://oauth.accounts.hytale.com/oauth2/device/verify"
    // "Authorization code: XXXXXX"

    // First, try to get the complete URL with user_code parameter (preferred)
    const completeUrlMatch = cleanLogs.match(/(https?:\/\/oauth\.accounts\.hytale\.com\/[^\s]*\?user_code=[a-zA-Z0-9]+)/i);

    // Fallback: get any oauth URL
    const basicUrlMatch = cleanLogs.match(/(https?:\/\/oauth\.accounts\.hytale\.com\/[^\s?]+)/i);

    // Get the authorization code
    const codeMatch = cleanLogs.match(/authorization\s+code:\s*([a-zA-Z0-9]+)/i);

    // Use complete URL if available, otherwise use basic URL
    let verificationUrl = completeUrlMatch ? completeUrlMatch[1].trim() : (basicUrlMatch ? basicUrlMatch[1].trim() : null);
    const userCode = codeMatch ? codeMatch[1].trim() : null;

    // If we only have basic URL, try to extract code from URL or use authorization code
    if (verificationUrl && !verificationUrl.includes('user_code=') && userCode) {
      verificationUrl += `?user_code=${userCode}`;
    }

    if (!verificationUrl || !userCode) {
      console.error('[HytaleAuth] Could not parse auth response. Logs:', cleanLogs.substring(cleanLogs.length - 1000));
      return {
        success: false,
        error: 'Could not parse authentication response from server logs. Make sure the server is running.',
      };
    }

    const deviceCode = userCode; // Use userCode as deviceCode

    // Save status with expiry (typically 15 minutes for device codes)
    const expiresAt = Date.now() + (15 * 60 * 1000);
    await saveAuthStatus({
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
      expiresIn: 900, // 15 minutes
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Gets the base Hytale path (parent of serverPath)
 * e.g., if serverPath is /opt/hytale/server, returns /opt/hytale
 */
function getHytaleBasePath(): string {
  return path.dirname(config.serverPath);
}

/**
 * Lists all files in the auth directories
 * Checks both /opt/hytale/auth and /opt/hytale/server/auth
 */
export async function listAuthFiles(): Promise<string[]> {
  const allFiles: string[] = [];
  const basePath = getHytaleBasePath();

  // Check auth directories at different locations
  const authDirs = [
    path.join(basePath, 'auth'),           // /opt/hytale/auth (main auth folder)
    path.join(config.serverPath, 'auth'),  // /opt/hytale/server/auth
    path.join(config.serverPath, '.auth'), // /opt/hytale/server/.auth
  ];

  for (const authDir of authDirs) {
    try {
      const files = await fs.readdir(authDir);
      console.log(`[HytaleAuth] Files in ${authDir}:`, files);
      allFiles.push(...files);
    } catch {
      // Directory doesn't exist, continue
    }
  }

  if (allFiles.length === 0) {
    console.log('[HytaleAuth] No auth directories found or they are empty');
  }

  return allFiles;
}

/**
 * Reads and returns the structure of the downloader credentials file
 * This helps understand what format the credentials are in
 */
export async function inspectDownloaderCredentials(): Promise<{ exists: boolean; structure?: any; error?: string }> {
  try {
    const downloaderCredsPath = '/opt/hytale/downloader/.hytale-downloader-credentials.json';

    try {
      const content = await fs.readFile(downloaderCredsPath, 'utf-8');
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

      console.log('[HytaleAuth] Downloader credentials structure:', structure);

      return {
        exists: true,
        structure,
      };
    } catch (readError) {
      console.log('[HytaleAuth] Could not read downloader credentials:', readError);
      return {
        exists: false,
        error: 'File not found or not readable',
      };
    }
  } catch (error) {
    console.error('[HytaleAuth] Error inspecting downloader credentials:', error);
    return {
      exists: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Checks if the server has a saved authentication token file
 * Common locations: server folder, config folder, or home directory
 */
async function checkTokenFileExists(): Promise<boolean> {
  try {
    // First, list what's in the auth directory
    const authFiles = await listAuthFiles();

    const basePath = getHytaleBasePath();

    // Try common token file locations
    const possiblePaths = [
      // Main auth folder at /opt/hytale/auth (same level as server)
      path.join(basePath, 'auth', 'credentials.json'),
      path.join(basePath, 'auth', 'oauth_credentials.json'),
      path.join(basePath, 'auth', 'credentials.enc'),
      path.join(basePath, 'auth', 'auth.enc'),
      path.join(basePath, 'auth', 'token'),
      path.join(basePath, 'auth', 'oauth_token'),
      // Root server folder
      path.join(config.serverPath, 'auth.enc'),
      path.join(config.serverPath, '.hytale_token'),
      path.join(config.serverPath, 'auth_token'),
      path.join(config.serverPath, 'oauth_token.json'),
      path.join(config.serverPath, 'oauth_credentials.json'),
      path.join(config.serverPath, '.oauth_token'),
      // Config folder
      path.join(config.serverPath, 'config', 'auth_token'),
      path.join(config.serverPath, 'config', 'oauth_token.json'),
      // 'auth' subfolder in server
      path.join(config.serverPath, 'auth', 'credentials.json'),
      path.join(config.serverPath, 'auth', 'oauth_credentials.json'),
      path.join(config.serverPath, 'auth', 'credentials.enc'),
      path.join(config.serverPath, 'auth', 'auth.enc'),
      // '.auth' subfolder in server
      path.join(config.serverPath, '.auth', 'credentials.json'),
      path.join(config.serverPath, '.auth', 'oauth_credentials.json'),
      path.join(config.serverPath, '.auth', 'credentials.enc'),
      path.join(config.serverPath, '.auth', 'auth.enc'),
    ];

    for (const tokenPath of possiblePaths) {
      try {
        await fs.access(tokenPath);
        // File exists
        console.log(`[HytaleAuth] Found Hytale auth token at: ${tokenPath}`);
        return true;
      } catch {
        // File doesn't exist, try next
        continue;
      }
    }

    // If we have ANY files in the .auth directory, consider it as having tokens
    if (authFiles.length > 0) {
      console.log(`[HytaleAuth] Found ${authFiles.length} file(s) in .auth directory, considering as authenticated`);
      return true;
    }

    return false;
  } catch (error) {
    console.error('[HytaleAuth] Error checking token file:', error);
    return false;
  }
}

/**
 * Checks if the authentication has been completed by the user
 * Checks for real server auth tokens (auth.enc), not downloader credentials
 */
export async function checkAuthCompletion(): Promise<ActionResponse> {
  try {
    const status = await getAuthStatus();
    const basePath = getHytaleBasePath();

    // Check for REAL server token files (auth.enc)
    // These are created by /auth login device with persistence Encrypted
    // NOT credentials.json/oauth_credentials.json (those are downloader credentials)
    const serverTokenPaths = [
      path.join(basePath, 'auth', 'auth.enc'),
      path.join(config.serverPath, '.auth', 'auth.enc'),
      path.join(config.serverPath, 'auth.enc'),
    ];

    for (const tokenPath of serverTokenPaths) {
      try {
        await fs.access(tokenPath);
        console.log(`[HytaleAuth] Found server auth token at: ${tokenPath}`);
        await saveAuthStatus({
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

    // If there's a pending device code, check expiration
    if (status.deviceCode) {
      if (status.expiresAt && Date.now() > status.expiresAt) {
        await saveAuthStatus({ authenticated: false });
        return {
          success: false,
          error: 'Authentication code has expired. Please initiate login again.',
        };
      }

      return {
        success: false,
        error: 'Authentication not yet completed. Please complete the authentication in your browser.',
      };
    }

    // Check saved status (for memory-only auth)
    if (status.authenticated) {
      return {
        success: true,
        message: 'Server appears to be authenticated (memory only - will need re-auth after restart).',
      };
    }

    // Not authenticated
    return {
      success: false,
      error: 'Server requires authentication. Run /auth persistence Encrypted then /auth login device.',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Resets the authentication status (for logout or retry)
 */
export async function resetAuth(): Promise<ActionResponse> {
  try {
    await saveAuthStatus({ authenticated: false });
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
