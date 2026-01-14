import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as playersService from '../services/players.js';
import * as dockerService from '../services/docker.js';

const router = Router();

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

// POST /api/players/:name/kick
router.post('/:name/kick', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  // Send kick command to server
  const result = await dockerService.execCommand(`/kick ${playerName}`);

  if (result.success) {
    playersService.removePlayer(playerName);
    res.json({
      success: true,
      message: `Player ${playerName} kicked`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to kick player',
    });
  }
});

// POST /api/players/:name/ban
router.post('/:name/ban', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  const result = await dockerService.execCommand(`/ban ${playerName}`);

  if (result.success) {
    playersService.removePlayer(playerName);
    res.json({
      success: true,
      message: `Player ${playerName} banned`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to ban player',
    });
  }
});

// DELETE /api/players/:name/ban
router.delete('/:name/ban', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  const result = await dockerService.execCommand(`/unban ${playerName}`);

  if (result.success) {
    res.json({
      success: true,
      message: `Player ${playerName} unbanned`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to unban player',
    });
  }
});

// POST /api/players/:name/whitelist
router.post('/:name/whitelist', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  const result = await dockerService.execCommand(`/whitelist add ${playerName}`);

  if (result.success) {
    res.json({
      success: true,
      message: `Player ${playerName} added to whitelist`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to add to whitelist',
    });
  }
});

// DELETE /api/players/:name/whitelist
router.delete('/:name/whitelist', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  const result = await dockerService.execCommand(`/whitelist remove ${playerName}`);

  if (result.success) {
    res.json({
      success: true,
      message: `Player ${playerName} removed from whitelist`,
    });
  } else {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to remove from whitelist',
    });
  }
});

// POST /api/players/:name/op
router.post('/:name/op', authMiddleware, async (req: Request, res: Response) => {
  const playerName = req.params.name;

  const result = await dockerService.execCommand(`/op ${playerName}`);

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

  const result = await dockerService.execCommand(`/deop ${playerName}`);

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

  if (!message || typeof message !== 'string') {
    res.status(400).json({
      success: false,
      error: 'Message is required',
    });
    return;
  }

  const result = await dockerService.execCommand(`/tell ${playerName} ${message}`);

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

export default router;
