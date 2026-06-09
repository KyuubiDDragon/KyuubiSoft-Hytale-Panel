// Mod / plugin config-file discovery + arbitrary config file read/write endpoints.
import { Router, Request, Response } from 'express';
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { config } from '../../config.js';
import { logActivity } from '../../services/activityLog.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { getRealPathIfSafe } from '../../utils/pathSecurity.js';
import { isAbsolutePathAllowed } from '../../services/fileManager.js';
import {
  extractBaseModName,
  findConfigDirs,
} from '../../services/managementHelpers.js';

const router = Router();

// GET /api/management/mods/:filename/configs
router.get('/mods/:filename/configs', authMiddleware, requirePermission('mods.view'), async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const modName = filename.replace(/\.(jar|zip|disabled)$/i, '');
    const baseModName = extractBaseModName(filename);

    console.log(`Looking for configs for mod: ${filename}, baseName: ${baseModName}`);

    // Priority search locations (mods directory first!)
    const configPaths: string[] = [];

    // 1. First search in mods directory (highest priority)
    const modsMatches = await findConfigDirs(config.modsPath, baseModName);
    configPaths.push(...modsMatches);
    console.log(`Found in modsPath (${config.modsPath}):`, modsMatches);

    // 2. Exact matches in common locations
    configPaths.push(
      path.join(config.modsPath, modName),
      path.join(config.modsPath, baseModName),
      path.join(config.modsPath, 'config', modName),
      path.join(config.modsPath, 'config', baseModName),
      path.join(config.serverPath, 'config', modName),
      path.join(config.serverPath, 'config', baseModName),
      path.join(config.dataPath, 'config', modName),
      path.join(config.dataPath, 'config', baseModName),
    );

    // 3. Also search in server/config and data/config for fuzzy matches
    const serverConfigMatches = await findConfigDirs(path.join(config.serverPath, 'config'), baseModName);
    const dataConfigMatches = await findConfigDirs(path.join(config.dataPath, 'config'), baseModName);
    configPaths.push(...serverConfigMatches, ...dataConfigMatches);

    // Deduplicate paths
    const uniquePaths = [...new Set(configPaths)];

    const configs: { name: string; path: string }[] = [];

    for (const configPath of uniquePaths) {
      try {
        const entries = await readdir(configPath);
        for (const entry of entries) {
          const ext = path.extname(entry).toLowerCase();
          if (['.json', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.properties'].includes(ext)) {
            const fullPath = path.join(configPath, entry);
            // Avoid duplicates
            if (!configs.some(c => c.path === fullPath)) {
              configs.push({
                name: entry,
                path: fullPath,
              });
            }
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    console.log(`Found ${configs.length} config files for ${filename}:`, configs.map(c => c.path));
    res.json({ configs });
  } catch (error) {
    console.error('Failed to get mod configs:', error);
    res.status(500).json({ error: 'Failed to get mod configs' });
  }
});

// GET /api/management/plugins/:filename/configs
router.get('/plugins/:filename/configs', authMiddleware, requirePermission('plugins.view'), async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const pluginName = filename.replace(/\.(jar|zip|disabled)$/i, '');
    const basePluginName = extractBaseModName(filename);

    console.log(`Looking for configs for plugin: ${filename}, baseName: ${basePluginName}`);

    // Priority search locations (plugins directory first!)
    const configPaths: string[] = [];

    // 1. First search in plugins directory (highest priority)
    const pluginsMatches = await findConfigDirs(config.pluginsPath, basePluginName);
    configPaths.push(...pluginsMatches);

    // 2. Exact matches in common locations
    configPaths.push(
      path.join(config.pluginsPath, pluginName),
      path.join(config.pluginsPath, basePluginName),
      path.join(config.pluginsPath, 'config', pluginName),
      path.join(config.pluginsPath, 'config', basePluginName),
      path.join(config.serverPath, 'plugins', pluginName),
      path.join(config.serverPath, 'plugins', basePluginName),
      path.join(config.dataPath, 'plugins', pluginName),
      path.join(config.dataPath, 'plugins', basePluginName),
    );

    // 3. Also search in server/plugins and data/plugins for fuzzy matches
    const serverPluginsMatches = await findConfigDirs(path.join(config.serverPath, 'plugins'), basePluginName);
    const dataPluginsMatches = await findConfigDirs(path.join(config.dataPath, 'plugins'), basePluginName);
    configPaths.push(...serverPluginsMatches, ...dataPluginsMatches);

    // Deduplicate paths
    const uniquePaths = [...new Set(configPaths)];

    const configs: { name: string; path: string }[] = [];

    for (const configPath of uniquePaths) {
      try {
        const entries = await readdir(configPath);
        for (const entry of entries) {
          const ext = path.extname(entry).toLowerCase();
          if (['.json', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.properties'].includes(ext)) {
            const fullPath = path.join(configPath, entry);
            // Avoid duplicates
            if (!configs.some(c => c.path === fullPath)) {
              configs.push({
                name: entry,
                path: fullPath,
              });
            }
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    console.log(`Found ${configs.length} config files for plugin ${filename}:`, configs.map(c => c.path));
    res.json({ configs });
  } catch (error) {
    console.error('Failed to get plugin configs:', error);
    res.status(500).json({ error: 'Failed to get plugin configs' });
  }
});

// GET /api/management/config/read
router.get('/config/read', authMiddleware, requirePermission('config.view'), async (req: Request, res: Response) => {
  try {
    const configPath = req.query.path as string;
    if (!configPath) {
      res.status(400).json({ error: 'Path required' });
      return;
    }

    // SECURITY: Use proper path validation to prevent traversal attacks
    const allowedDirectories = [config.modsPath, config.pluginsPath, config.serverPath, config.dataPath];
    const safePath = getRealPathIfSafe(configPath, allowedDirectories);

    // The root-boundary check above does NOT block secret/credential files.
    // Apply the file-manager deny-list so config.view can't be used to read
    // auth.enc, users.json, *.key/*.pem, etc. inside an allowed root.
    if (!safePath || !isAbsolutePathAllowed(safePath, 'read')) {
      console.warn(`[SECURITY] Blocked config read for disallowed path: ${configPath}`);
      res.status(403).json({ error: 'Access denied - invalid path' });
      return;
    }

    const content = await readFile(safePath, 'utf-8');
    res.json({ content, path: safePath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read config' });
  }
});

// PUT /api/management/config/write
router.put('/config/write', authMiddleware, requirePermission('config.edit'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { path: configPath, content } = req.body;
    if (!configPath || content === undefined) {
      res.status(400).json({ error: 'Path and content required' });
      return;
    }

    // SECURITY: Use proper path validation to prevent traversal attacks
    const allowedDirectories = [config.modsPath, config.pluginsPath, config.serverPath, config.dataPath];
    const safePath = getRealPathIfSafe(configPath, allowedDirectories);

    // Root-boundary alone is not enough for writes: without the deny-list a
    // config.edit holder (e.g. the non-admin Operator role) could overwrite
    // HytaleServer.jar (RCE on restart) or the schema-validated config.json /
    // users.json. Enforce the same deny rules the file manager uses.
    if (!safePath || !isAbsolutePathAllowed(safePath, 'write')) {
      console.warn(`[SECURITY] Blocked config write for disallowed path: ${configPath}`);
      res.status(403).json({ error: 'Access denied - invalid path' });
      return;
    }

    await writeFile(safePath, content, 'utf-8');

    await logActivity(
      req.user || 'unknown',
      'edit_config',
      'config',
      true,
      path.basename(safePath),
      `Edited config: ${safePath}`
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to write config' });
  }
});

export default router;
