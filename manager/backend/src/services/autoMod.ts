/**
 * Auto-moderation of in-game chat.
 *
 * OFF by default. Enabled via config.automod.enabled. Subscribes to the
 * plugin's player_chat events and evaluates each message against a set of
 * configurable rules (banned words, links, excessive caps, length, flood).
 * On the first matching rule it applies the configured action:
 *   - warn  → public reminder via /say + a recorded 'warn' punishment
 *   - mute  → /mute the player + recorded mute/tempmute
 *   - kick  → /kick the player + recorded kick
 *
 * Everything is wrapped defensively: a bad rule or a server hiccup must never
 * crash the panel. Flood detection is in-memory and resets on restart.
 */
import { eventBus, type PanelEvent } from './eventBus.js';
import { getConfig } from './configService.js';
import { isDemoMode } from './demoData.js';
import { logActivity } from './activityLog.js';
import { recordPunishment } from './punishments.js';
import { logger } from '../utils/logger.js';

const SYSTEM_USER = 'AutoMod';
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|gg|me|tv|co|xyz|dev)\b/i;

// Per-player recent-message timestamps for flood detection.
const recentByPlayer = new Map<string, number[]>();
let unsubscribe: (() => void) | null = null;

interface Violation {
  rule: 'bannedWord' | 'link' | 'caps' | 'length' | 'flood';
  detail: string;
}

type AutoModConfig = NonNullable<Awaited<ReturnType<typeof getConfig>>['automod']>;

/** Fraction of letters that are uppercase, 0..1. Non-letters are ignored. */
function capsRatio(text: string): number {
  let letters = 0;
  let upper = 0;
  for (const ch of text) {
    if (/[a-zA-ZÀ-ÖØ-öø-ÿ]/.test(ch)) {
      letters++;
      if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) upper++;
    }
  }
  return letters > 0 ? upper / letters : 0;
}

/** Evaluate a message against the rules. Returns the first violation, if any. */
function evaluate(cfg: AutoModConfig, player: string, message: string, now: number): Violation | null {
  const text = message.trim();
  if (!text) return null;

  // Banned words — whole-word, case-insensitive.
  if (cfg.bannedWords?.length) {
    const lower = text.toLowerCase();
    for (const raw of cfg.bannedWords) {
      const word = String(raw).trim().toLowerCase();
      if (!word) continue;
      const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(word)}(?:[^\\p{L}\\p{N}]|$)`, 'u');
      if (re.test(` ${lower} `) || lower.includes(word)) {
        return { rule: 'bannedWord', detail: `banned word "${word}"` };
      }
    }
  }

  if (cfg.blockLinks && URL_RE.test(text)) {
    return { rule: 'link', detail: 'posted a link' };
  }

  if (cfg.maxCapsPercent > 0 && text.length >= 8) {
    const pct = Math.round(capsRatio(text) * 100);
    if (pct > cfg.maxCapsPercent) {
      return { rule: 'caps', detail: `${pct}% caps (limit ${cfg.maxCapsPercent}%)` };
    }
  }

  if (cfg.maxMessageLength > 0 && text.length > cfg.maxMessageLength) {
    return { rule: 'length', detail: `message length ${text.length} (limit ${cfg.maxMessageLength})` };
  }

  if (cfg.floodCount > 0 && cfg.floodWindowSec > 0) {
    const windowMs = cfg.floodWindowSec * 1000;
    const stamps = (recentByPlayer.get(player) ?? []).filter((t) => now - t < windowMs);
    stamps.push(now);
    recentByPlayer.set(player, stamps);
    if (stamps.length > cfg.floodCount) {
      return { rule: 'flood', detail: `${stamps.length} messages in ${cfg.floodWindowSec}s` };
    }
  }

  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function enforce(cfg: AutoModConfig, player: string, serverId: string | undefined, v: Violation): Promise<void> {
  const reason = `AutoMod: ${v.detail}`;
  const { execCommand } = await import('./docker.js');
  try {
    if (cfg.action === 'kick') {
      await execCommand(`/kick ${player} ${reason}`, serverId);
      recordPunishment({ serverId, playerName: player, type: 'kick', reason, byUser: SYSTEM_USER });
    } else if (cfg.action === 'mute') {
      await execCommand(`/mute ${player}`, serverId);
      const durationMs = cfg.muteDurationSec > 0 ? cfg.muteDurationSec * 1000 : null;
      recordPunishment({
        serverId, playerName: player,
        type: durationMs ? 'tempmute' : 'mute',
        reason, byUser: SYSTEM_USER, durationMs,
      });
    } else {
      // warn — public reminder + recorded warning, no kick/mute.
      await execCommand(`/say [AutoMod] ${player}, please mind the chat rules (${v.detail}).`, serverId);
      recordPunishment({ serverId, playerName: player, type: 'warn', reason, byUser: SYSTEM_USER });
    }
    await logActivity(SYSTEM_USER, `automod_${cfg.action}`, 'player', true, player, v.detail);
    logger.info(`[AutoMod] ${cfg.action} ${player} — ${v.detail}`);
  } catch (err) {
    logger.warn(`[AutoMod] enforcement failed for ${player}: ${err instanceof Error ? err.message : err}`);
  }
}

export function startAutoMod(): void {
  if (unsubscribe || isDemoMode()) return;
  unsubscribe = eventBus.subscribe(['player_chat'], (evt: PanelEvent) => {
    void handleChat(evt);
  });
  logger.info('[AutoMod] chat monitor active (configure via config.automod)');
}

async function handleChat(evt: PanelEvent): Promise<void> {
  try {
    const cfg = (await getConfig()).automod;
    if (!cfg?.enabled) return;
    const p = evt.payload as { player?: string; message?: string; serverId?: string };
    if (!p.player || !p.message) return;
    const now = Date.now();
    const violation = evaluate(cfg, p.player, p.message, now);
    if (violation) await enforce(cfg, p.player, p.serverId, violation);
  } catch (err) {
    logger.warn(`[AutoMod] handler error: ${err instanceof Error ? err.message : err}`);
  }
}

export function stopAutoMod(): void {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  recentByPlayer.clear();
}
