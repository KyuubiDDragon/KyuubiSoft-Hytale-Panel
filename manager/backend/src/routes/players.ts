import { Router, Request, Response } from 'express';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../middleware/auth.js';
import * as playersService from '../services/players.js';
import * as dockerService from '../services/docker.js';
import { config } from '../config.js';
import { logActivity } from '../services/activityLog.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  isValidPlayerName,
  isValidGamemode,
  isValidItemId,
  isValidNumber,
  isValidCoordinate,
  isValidEffectName,
  sanitizeMessage,
} from '../utils/sanitize.js';

const router = Router();

// SECURITY: Validate player name from URL params
function validatePlayerName(res: Response, name: string): boolean {
  if (!isValidPlayerName(name)) {
    res.status(400).json({
      success: false,
      error: 'Invalid player name. Only alphanumeric characters, underscores and hyphens allowed.',
    });
    return false;
  }
  return true;
}

// ============== FILE PERSISTENCE HELPERS ==============

interface WhitelistData {
  enabled: boolean;
  list: string[];
}

async function readWhitelist(): Promise<WhitelistData> {
  try {
    const content = await readFile(path.join(config.serverPath, 'whitelist.json'), 'utf-8');
    return JSON.parse(content);
  } catch {
    return { enabled: false, list: [] };
  }
}

async function writeWhitelist(data: WhitelistData): Promise<void> {
  await writeFile(path.join(config.serverPath, 'whitelist.json'), JSON.stringify(data, null, 2), 'utf-8');
}

// Name mapping for bans (UUID -> player name)
interface BanNameMapping {
  [uuid: string]: string;
}

async function readBansMapping(): Promise<BanNameMapping> {
  try {
    const content = await readFile(path.join(config.serverPath, 'bans-names.json'), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeBansMapping(mapping: BanNameMapping): Promise<void> {
  await writeFile(path.join(config.serverPath, 'bans-names.json'), JSON.stringify(mapping, null, 2), 'utf-8');
}

// GET /api/players
router.get('/', authMiddleware, async (_req: Request, res: Response) => {
  const players = await playersService.getOnlinePlayers();

  res.json({
    players,
    count: players.length,
  });
});

// GET /api/players/count
router.get('/count', authMiddleware, async (_req: Request, res: Response) => {
  const count = await playersService.getPlayerCount();
  res.json({ count });
});

// GET /api/players/history - All players who have ever joined
router.get('/history', authMiddleware, async (_req: Request, res: Response) => {
  const history = await playersService.getPlayerHistory();
  res.json({ players: history, count: history.length });
});

// GET /api/players/offline - Players in history who are currently offline
router.get('/offline', authMiddleware, async (_req: Request, res: Response) => {
  const offline = await playersService.getOfflinePlayers();
  res.json({ players: offline, count: offline.length });
});

// POST /api/players/:name/kick
router.post('/:name/kick', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const playerName = req.params.name;
  const { reason } = req.body;
  const username = req.user || 'system';

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  // SECURITY: Sanitize reason if provided
  const safeReason = reason ? sanitizeMessage(reason, 100) : '';

  // Send kick command to server (with optional reason)
  const command = safeReason ? `/kick ${playerName} ${safeReason}` : `/kick ${playerName}`;
  const result = await dockerService.execCommand(command);

  if (result.success) {
    playersService.removePlayer(playerName);

    // Log activity
    await logActivity(username, 'kick', 'player', true, playerName, reason);

    res.json({
      success: true,
      message: `Player ${playerName} kicked`,
    });
  } else {
    await logActivity(username, 'kick', 'player', false, playerName, result.error);

    res.status(500).json({
      success: false,
      error: result.error || 'Failed to kick player',
    });
  }
});

// POST /api/players/:name/ban
router.post('/:name/ban', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const playerName = req.params.name;
  const { reason } = req.body;
  const username = req.user || 'system';

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  // SECURITY: Sanitize reason if provided
  const safeReason = reason ? sanitizeMessage(reason, 100) : 'You have been banned';

  // First kick the player if online
  await dockerService.execCommand(`/kick ${playerName} ${safeReason}`);

  // Then execute ban command - server will update bans.json with UUID
  const command = `/ban ${playerName} ${safeReason}`;
  const result = await dockerService.execCommand(command);

  if (result.success) {
    playersService.removePlayer(playerName);

    // Store player name in mapping file for display purposes
    // The server's bans.json uses UUIDs, we need names for the UI
    try {
      const mapping = await readBansMapping();
      // We'll update the mapping when the bans list is read
      // For now, just ensure we have a way to associate names
      mapping[playerName] = playerName; // Temporary - will be replaced with UUID mapping
      await writeBansMapping(mapping);

      // Remove from whitelist if present
      const whitelist = await readWhitelist();
      if (whitelist.list.includes(playerName)) {
        whitelist.list = whitelist.list.filter(p => p !== playerName);
        await writeWhitelist(whitelist);
      }
    } catch (err) {
      console.error('Failed to update ban mapping:', err);
    }

    // Log activity
    await logActivity(username, 'ban', 'player', true, playerName, reason);

    res.json({
      success: true,
      message: `Player ${playerName} banned`,
    });
  } else {
    await logActivity(username, 'ban', 'player', false, playerName, result.error);

    res.status(500).json({
      success: false,
      error: result.error || 'Failed to ban player',
    });
  }
});

// DELETE /api/players/:name/ban
router.delete('/:name/ban', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const playerName = req.params.name;
  const username = req.user || 'system';

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  // Execute unban command - server will update bans.json
  const result = await dockerService.execCommand(`/unban ${playerName}`);

  if (result.success) {
    // Log activity
    await logActivity(username, 'unban', 'player', true, playerName);

    res.json({
      success: true,
      message: `Player ${playerName} unbanned`,
    });
  } else {
    await logActivity(username, 'unban', 'player', false, playerName, result.error);

    res.status(500).json({
      success: false,
      error: result.error || 'Failed to unban player',
    });
  }
});

// POST /api/players/:name/whitelist
router.post('/:name/whitelist', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const playerName = req.params.name;
  const username = req.user || 'system';

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  const result = await dockerService.execCommand(`/whitelist add ${playerName}`);

  if (result.success) {
    // Persist to whitelist.json
    try {
      const whitelist = await readWhitelist();
      if (!whitelist.list.includes(playerName)) {
        whitelist.list.push(playerName);
        await writeWhitelist(whitelist);
      }
    } catch (err) {
      console.error('Failed to persist whitelist:', err);
    }

    // Log activity
    await logActivity(username, 'whitelist_add', 'player', true, playerName);

    res.json({
      success: true,
      message: `Player ${playerName} added to whitelist`,
    });
  } else {
    await logActivity(username, 'whitelist_add', 'player', false, playerName, result.error);

    res.status(500).json({
      success: false,
      error: result.error || 'Failed to add to whitelist',
    });
  }
});

// DELETE /api/players/:name/whitelist
router.delete('/:name/whitelist', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const playerName = req.params.name;
  const username = req.user || 'system';

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  const result = await dockerService.execCommand(`/whitelist remove ${playerName}`);

  if (result.success) {
    // Remove from whitelist.json
    try {
      const whitelist = await readWhitelist();
      whitelist.list = whitelist.list.filter(p => p !== playerName);
      await writeWhitelist(whitelist);
    } catch (err) {
      console.error('Failed to persist whitelist removal:', err);
    }

    // Log activity
    await logActivity(username, 'whitelist_remove', 'player', true, playerName);

    res.json({
      success: true,
      message: `Player ${playerName} removed from whitelist`,
    });
  } else {
    await logActivity(username, 'whitelist_remove', 'player', false, playerName, result.error);

    res.status(500).json({
      success: false,
      error: result.error || 'Failed to remove from whitelist',
    });
  }
});

// POST /api/players/:name/op
router.post('/:name/op', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  const result = await dockerService.execCommand(`/op add ${playerName}`);

  if (result.success) {
    res.json({
      success: true,
      message: `Player ${playerName} is now an operator`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to op player',
    });
  }
});

// DELETE /api/players/:name/op
router.delete('/:name/op', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  const result = await dockerService.execCommand(`/op remove ${playerName}`);

  if (result.success) {
    res.json({
      success: true,
      message: `Player ${playerName} is no longer an operator`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to deop player',
    });
  }
});

// POST /api/players/:name/message
router.post('/:name/message', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;
  const { message } = req.body;

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  if (!message || typeof message !== 'string') {
    res.status(400).json({
      success: false,
      error: 'Message is required',
    });
    return;
  }

  // SECURITY: Sanitize message
  const safeMessage = sanitizeMessage(message, 256);

  const result = await dockerService.execCommand(`/msg ${playerName} ${safeMessage}`);

  if (result.success) {
    res.json({
      success: true,
      message: `Message sent to ${playerName}`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to send message',
    });
  }
});

// POST /api/players/:name/teleport
router.post('/:name/teleport', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;
  const { target, x, y, z } = req.body;

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  let command: string;
  if (target) {
    // SECURITY: Validate target player name
    if (!isValidPlayerName(target)) {
      res.status(400).json({ success: false, error: 'Invalid target player name' });
      return;
    }
    // Teleport player to another player: /tp <source> <target>
    command = `/tp ${playerName} ${target}`;
  } else if (x !== undefined && y !== undefined && z !== undefined) {
    // SECURITY: Validate coordinates
    if (!isValidCoordinate(x) || !isValidCoordinate(y) || !isValidCoordinate(z)) {
      res.status(400).json({ success: false, error: 'Invalid coordinates' });
      return;
    }
    // Teleport to coordinates: /tp <player> <x> <y> <z>
    command = `/tp ${playerName} ${x} ${y} ${z}`;
  } else {
    res.status(400).json({
      success: false,
      error: 'Either target player or coordinates (x, y, z) required',
    });
    return;
  }

  const result = await dockerService.execCommand(command);

  if (result.success) {
    res.json({
      success: true,
      message: target ? `Teleported ${playerName} to ${target}` : `Teleported ${playerName} to ${x}, ${y}, ${z}`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to teleport player',
    });
  }
});

// POST /api/players/:name/kill
router.post('/:name/kill', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  const result = await dockerService.execCommand(`/kill ${playerName}`);

  if (result.success) {
    res.json({
      success: true,
      message: `Player ${playerName} killed`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to kill player',
    });
  }
});

// POST /api/players/:name/respawn
router.post('/:name/respawn', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  const result = await dockerService.execCommand(`/player respawn ${playerName}`);

  if (result.success) {
    res.json({
      success: true,
      message: `Player ${playerName} respawned`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to respawn player',
    });
  }
});

// POST /api/players/:name/gamemode
router.post('/:name/gamemode', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;
  const { gamemode } = req.body;

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  if (!gamemode) {
    res.status(400).json({
      success: false,
      error: 'Gamemode is required',
    });
    return;
  }

  // SECURITY: Validate gamemode
  if (!isValidGamemode(gamemode)) {
    res.status(400).json({
      success: false,
      error: 'Invalid gamemode. Use: survival, creative, adventure, spectator',
    });
    return;
  }

  const result = await dockerService.execCommand(`/gamemode ${gamemode} ${playerName}`);

  if (result.success) {
    res.json({
      success: true,
      message: `Set ${playerName}'s gamemode to ${gamemode}`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to change gamemode',
    });
  }
});

// POST /api/players/:name/give
router.post('/:name/give', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;
  const { item, amount } = req.body;

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  if (!item) {
    res.status(400).json({
      success: false,
      error: 'Item is required',
    });
    return;
  }

  // SECURITY: Validate item ID format
  if (!isValidItemId(String(item).toLowerCase())) {
    res.status(400).json({
      success: false,
      error: 'Invalid item ID format. Use: namespace:item_name',
    });
    return;
  }

  // SECURITY: Validate amount if provided
  if (amount !== undefined && !isValidNumber(amount)) {
    res.status(400).json({
      success: false,
      error: 'Invalid amount. Must be a number.',
    });
    return;
  }

  const command = amount ? `/give ${playerName} ${item} ${amount}` : `/give ${playerName} ${item}`;
  const result = await dockerService.execCommand(command);

  if (result.success) {
    res.json({
      success: true,
      message: `Gave ${amount || 1} ${item} to ${playerName}`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to give item',
    });
  }
});

// POST /api/players/:name/heal
router.post('/:name/heal', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  const result = await dockerService.execCommand(`/player stats settomax ${playerName} health`);

  if (result.success) {
    res.json({
      success: true,
      message: `Player ${playerName} healed`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to heal player',
    });
  }
});

// POST /api/players/:name/effect
router.post('/:name/effect', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;
  const { effect, action } = req.body;

  // SECURITY: Validate player name
  if (!validatePlayerName(res, playerName)) return;

  if (!effect && action !== 'clear') {
    res.status(400).json({
      success: false,
      error: 'Effect is required',
    });
    return;
  }

  // SECURITY: Validate effect name if provided
  if (effect && !isValidEffectName(effect)) {
    res.status(400).json({
      success: false,
      error: 'Invalid effect name',
    });
    return;
  }

  const command = action === 'clear'
    ? `/player effect clear ${playerName}`
    : `/player effect apply ${playerName} ${effect}`;
  const result = await dockerService.execCommand(command);

  if (result.success) {
    res.json({
      success: true,
      message: action === 'clear' ? `Cleared effects from ${playerName}` : `Applied ${effect} to ${playerName}`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to apply effect',
    });
  }
});

// POST /api/players/:name/inventory/clear
router.post('/:name/inventory/clear', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  const result = await dockerService.execCommand(`/inventory clear ${playerName}`);

  if (result.success) {
    res.json({
      success: true,
      message: `Cleared ${playerName}'s inventory`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to clear inventory',
    });
  }
});

// GET /api/players/statistics - Get player statistics
router.get('/statistics', authMiddleware, async (_req: Request, res: Response) => {
  const stats = await playersService.getPlayerStatistics();
  res.json(stats);
});

// GET /api/players/activity - Get daily activity for charts
router.get('/activity', authMiddleware, async (req: Request, res: Response) => {
  const days = parseInt(req.query.days as string) || 7;
  const activity = await playersService.getDailyActivity(days);
  res.json(activity);
});

export default router;
