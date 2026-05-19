// Per-world configuration endpoints (config.json reads + writes, plus the
// generic /worlds/:worldName/files/* read/write that exposes resources/*.json).
import { Router, Request, Response } from 'express';
import { readFile, writeFile, stat } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { logActivity } from '../../services/activityLog.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { getWorldsPaths } from '../../services/managementHelpers.js';

const router = Router();

// GET /api/management/worlds/:worldName/config - Get world config
router.get('/worlds/:worldName/config', authMiddleware, requirePermission('worlds.view'), async (req: Request, res: Response) => {
  try {
    const { worldName } = req.params;

    // Security: validate world name
    if (!worldName || worldName.includes('..') || worldName.includes('/') || worldName.includes('\\')) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }

    // Try multiple possible paths for world config
    const possiblePaths = getWorldsPaths().map(wp => path.join(wp, worldName, 'config.json'));
    let configPath: string | null = null;
    let content: string | null = null;

    for (const tryPath of possiblePaths) {
      try {
        content = await readFile(tryPath, 'utf-8');
        configPath = tryPath;
        break;
      } catch {
        // Try next path
      }
    }

    if (!configPath || !content) {
      res.status(404).json({ error: 'World config not found' });
      return;
    }
    const worldConfig = JSON.parse(content);

    // Return normalized config
    res.json({
      name: worldName,
      raw: worldConfig,
      // Normalized fields for easy editing
      displayName: worldConfig.DisplayName || worldName,
      seed: worldConfig.Seed,
      isTicking: worldConfig.IsTicking ?? true,
      isBlockTicking: worldConfig.IsBlockTicking ?? true,
      isPvpEnabled: worldConfig.IsPvpEnabled ?? false,
      isFallDamageEnabled: worldConfig.IsFallDamageEnabled ?? true,
      isGameTimePaused: worldConfig.IsGameTimePaused ?? false,
      gameTime: worldConfig.GameTime,
      isSpawningNPC: worldConfig.IsSpawningNPC ?? true,
      isAllNPCFrozen: worldConfig.IsAllNPCFrozen ?? false,
      isSpawnMarkersEnabled: worldConfig.IsSpawnMarkersEnabled ?? true,
      isObjectiveMarkersEnabled: worldConfig.IsObjectiveMarkersEnabled ?? true,
      isSavingPlayers: worldConfig.IsSavingPlayers ?? true,
      isSavingChunks: worldConfig.IsSavingChunks ?? true,
      saveNewChunks: worldConfig.SaveNewChunks ?? true,
      isUnloadingChunks: worldConfig.IsUnloadingChunks ?? true,
      isCompassUpdating: worldConfig.IsCompassUpdating ?? true,
      gameplayConfig: worldConfig.GameplayConfig ?? 'Default',
      deleteOnUniverseStart: worldConfig.DeleteOnUniverseStart ?? false,
      deleteOnRemove: worldConfig.DeleteOnRemove ?? false,
      daytimeDurationSecondsOverride: worldConfig.DaytimeDurationSecondsOverride,
      nighttimeDurationSecondsOverride: worldConfig.NighttimeDurationSecondsOverride,
      clientEffects: worldConfig.ClientEffects ? {
        sunHeightPercent: worldConfig.ClientEffects.SunHeightPercent,
        sunAngleDegrees: worldConfig.ClientEffects.SunAngleDegrees,
        bloomIntensity: worldConfig.ClientEffects.BloomIntensity,
        bloomPower: worldConfig.ClientEffects.BloomPower,
        sunIntensity: worldConfig.ClientEffects.SunIntensity,
        sunshaftIntensity: worldConfig.ClientEffects.SunshaftIntensity,
        sunshaftScaleFactor: worldConfig.ClientEffects.SunshaftScaleFactor,
      } : undefined,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: 'World config not found' });
    } else {
      res.status(500).json({ error: 'Failed to read world config' });
    }
  }
});

// PUT /api/management/worlds/:worldName/config - Update world config
router.put('/worlds/:worldName/config', authMiddleware, requirePermission('worlds.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { worldName } = req.params;
    const updates = req.body;

    // Security: validate world name
    if (!worldName || worldName.includes('..') || worldName.includes('/') || worldName.includes('\\')) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }

    // Try multiple possible paths for world config
    const possiblePaths = getWorldsPaths().map(wp => path.join(wp, worldName, 'config.json'));
    let configPath: string | null = null;
    let content: string | null = null;

    for (const tryPath of possiblePaths) {
      try {
        content = await readFile(tryPath, 'utf-8');
        configPath = tryPath;
        break;
      } catch {
        // Try next path
      }
    }

    if (!configPath || !content) {
      res.status(404).json({ error: 'World config not found' });
      return;
    }

    // Read existing config
    const worldConfig = JSON.parse(content);

    // Apply updates (map camelCase to PascalCase)
    if (updates.displayName !== undefined) worldConfig.DisplayName = updates.displayName;
    if (updates.isTicking !== undefined) worldConfig.IsTicking = updates.isTicking;
    if (updates.isBlockTicking !== undefined) worldConfig.IsBlockTicking = updates.isBlockTicking;
    if (updates.isPvpEnabled !== undefined) worldConfig.IsPvpEnabled = updates.isPvpEnabled;
    if (updates.isFallDamageEnabled !== undefined) worldConfig.IsFallDamageEnabled = updates.isFallDamageEnabled;
    if (updates.isGameTimePaused !== undefined) worldConfig.IsGameTimePaused = updates.isGameTimePaused;
    if (updates.isSpawningNPC !== undefined) worldConfig.IsSpawningNPC = updates.isSpawningNPC;
    if (updates.isAllNPCFrozen !== undefined) worldConfig.IsAllNPCFrozen = updates.isAllNPCFrozen;
    if (updates.isSpawnMarkersEnabled !== undefined) worldConfig.IsSpawnMarkersEnabled = updates.isSpawnMarkersEnabled;
    if (updates.isObjectiveMarkersEnabled !== undefined) worldConfig.IsObjectiveMarkersEnabled = updates.isObjectiveMarkersEnabled;
    if (updates.isSavingPlayers !== undefined) worldConfig.IsSavingPlayers = updates.isSavingPlayers;
    if (updates.isSavingChunks !== undefined) worldConfig.IsSavingChunks = updates.isSavingChunks;
    if (updates.saveNewChunks !== undefined) worldConfig.SaveNewChunks = updates.saveNewChunks;
    if (updates.isUnloadingChunks !== undefined) worldConfig.IsUnloadingChunks = updates.isUnloadingChunks;
    if (updates.isCompassUpdating !== undefined) worldConfig.IsCompassUpdating = updates.isCompassUpdating;
    if (updates.gameplayConfig !== undefined) worldConfig.GameplayConfig = updates.gameplayConfig;
    if (updates.deleteOnUniverseStart !== undefined) worldConfig.DeleteOnUniverseStart = updates.deleteOnUniverseStart;
    if (updates.deleteOnRemove !== undefined) worldConfig.DeleteOnRemove = updates.deleteOnRemove;

    // Day/Night duration overrides
    if (updates.daytimeDurationSecondsOverride !== undefined) {
      if (updates.daytimeDurationSecondsOverride === null || updates.daytimeDurationSecondsOverride === '') {
        delete worldConfig.DaytimeDurationSecondsOverride;
      } else {
        worldConfig.DaytimeDurationSecondsOverride = Number(updates.daytimeDurationSecondsOverride);
      }
    }
    if (updates.nighttimeDurationSecondsOverride !== undefined) {
      if (updates.nighttimeDurationSecondsOverride === null || updates.nighttimeDurationSecondsOverride === '') {
        delete worldConfig.NighttimeDurationSecondsOverride;
      } else {
        worldConfig.NighttimeDurationSecondsOverride = Number(updates.nighttimeDurationSecondsOverride);
      }
    }

    // Client effects
    if (updates.clientEffects) {
      if (!worldConfig.ClientEffects) worldConfig.ClientEffects = {};
      if (updates.clientEffects.sunHeightPercent !== undefined)
        worldConfig.ClientEffects.SunHeightPercent = Number(updates.clientEffects.sunHeightPercent);
      if (updates.clientEffects.sunAngleDegrees !== undefined)
        worldConfig.ClientEffects.SunAngleDegrees = Number(updates.clientEffects.sunAngleDegrees);
      if (updates.clientEffects.bloomIntensity !== undefined)
        worldConfig.ClientEffects.BloomIntensity = Number(updates.clientEffects.bloomIntensity);
      if (updates.clientEffects.bloomPower !== undefined)
        worldConfig.ClientEffects.BloomPower = Number(updates.clientEffects.bloomPower);
      if (updates.clientEffects.sunIntensity !== undefined)
        worldConfig.ClientEffects.SunIntensity = Number(updates.clientEffects.sunIntensity);
      if (updates.clientEffects.sunshaftIntensity !== undefined)
        worldConfig.ClientEffects.SunshaftIntensity = Number(updates.clientEffects.sunshaftIntensity);
      if (updates.clientEffects.sunshaftScaleFactor !== undefined)
        worldConfig.ClientEffects.SunshaftScaleFactor = Number(updates.clientEffects.sunshaftScaleFactor);
    }

    // Write updated config
    await writeFile(configPath, JSON.stringify(worldConfig, null, 2), 'utf-8');

    // Log activity
    await logActivity(
      req.user || 'unknown',
      'update_world_config',
      'config',
      true,
      worldName,
      `Updated world config for ${worldName}`
    );

    res.json({ success: true, message: 'World config updated' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: 'World config not found' });
    } else {
      res.status(500).json({ error: 'Failed to update world config' });
    }
  }
});

// GET /api/management/worlds/:worldName/files/:filePath - Read any JSON file in a world
router.get('/worlds/:worldName/files/*', authMiddleware, requirePermission('worlds.view'), async (req: Request, res: Response) => {
  try {
    const { worldName } = req.params;
    const filePath = req.params[0]; // The wildcard part (e.g., "resources/Time.json")

    // Security: validate world name
    if (!worldName || worldName.includes('..') || worldName.includes('\\')) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }

    // Security: validate file path
    if (!filePath || filePath.includes('..') || !filePath.endsWith('.json')) {
      res.status(400).json({ error: 'Invalid file path. Only .json files are allowed.' });
      return;
    }

    // Only allow files in root or resources folder
    const pathParts = filePath.split('/');
    if (pathParts.length > 2 || (pathParts.length === 2 && pathParts[0] !== 'resources')) {
      res.status(400).json({ error: 'Invalid file path. Only root and resources/ folder allowed.' });
      return;
    }

    // Try multiple possible paths for the file
    const possiblePaths = getWorldsPaths().map(wp => path.join(wp, worldName, filePath));
    let content: string | null = null;

    for (const tryPath of possiblePaths) {
      try {
        content = await readFile(tryPath, 'utf-8');
        break;
      } catch {
        // Try next path
      }
    }

    if (!content) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Parse and return as JSON
    const data = JSON.parse(content);
    res.json({
      worldName,
      filePath,
      fileName: pathParts[pathParts.length - 1],
      content: data,
      raw: content,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: 'File not found' });
    } else if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'Invalid JSON file' });
    } else {
      res.status(500).json({ error: 'Failed to read file' });
    }
  }
});

// PUT /api/management/worlds/:worldName/files/:filePath - Update any JSON file in a world
router.put('/worlds/:worldName/files/*', authMiddleware, requirePermission('worlds.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { worldName } = req.params;
    const filePath = req.params[0];
    const { content } = req.body;

    // Security: validate world name
    if (!worldName || worldName.includes('..') || worldName.includes('\\')) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }

    // Security: validate file path
    if (!filePath || filePath.includes('..') || !filePath.endsWith('.json')) {
      res.status(400).json({ error: 'Invalid file path. Only .json files are allowed.' });
      return;
    }

    // Only allow files in root or resources folder
    const pathParts = filePath.split('/');
    if (pathParts.length > 2 || (pathParts.length === 2 && pathParts[0] !== 'resources')) {
      res.status(400).json({ error: 'Invalid file path. Only root and resources/ folder allowed.' });
      return;
    }

    if (content === undefined) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    // Validate JSON
    let jsonContent: string;
    if (typeof content === 'string') {
      // Validate it's valid JSON
      JSON.parse(content);
      jsonContent = content;
    } else {
      // Convert object to JSON string
      jsonContent = JSON.stringify(content, null, 2);
    }

    // Try multiple possible paths for the file
    const possiblePaths = getWorldsPaths().map(wp => path.join(wp, worldName, filePath));
    let targetPath: string | null = null;

    // Find existing file
    for (const tryPath of possiblePaths) {
      try {
        await stat(tryPath);
        targetPath = tryPath;
        break;
      } catch {
        // Try next path
      }
    }

    if (!targetPath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Write file
    await writeFile(targetPath, jsonContent, 'utf-8');

    // Log activity
    const fileName = pathParts[pathParts.length - 1];
    await logActivity(
      req.user || 'unknown',
      'update_world_file',
      'config',
      true,
      `${worldName}/${filePath}`,
      `Updated ${fileName} in world ${worldName}`
    );

    res.json({ success: true, message: `File ${fileName} updated` });
  } catch (error) {
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'Invalid JSON content' });
    } else {
      res.status(500).json({ error: 'Failed to update file' });
    }
  }
});

export default router;
