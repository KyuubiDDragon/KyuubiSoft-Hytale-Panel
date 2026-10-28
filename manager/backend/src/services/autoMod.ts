/**
 * Auto-moderation of in-game chat.
 *
 * OFF by default. Enabled via config.automod.enabled. Subscribes to the
 * plugin's player_chat events and evaluates each message against a set of
 * configurable rules (banned words, links, excessive caps, length, flood).
 * On the first matching rule it applies the configured action:
 *   - warn  → public reminder via /say + a recorded 'warn' punishment
 *   - kick  → /kick the player + recorded kick (the reason stays in the panel;
 *             Hytale 0.7's /kick takes no reason)
 *   - mute  → Hytale 0.7 has no chat mute, so a 'mute' setting from an older
 *             panel version warns instead (and says so in the log)
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
import { isValidPlayerName, stripControlChars, toCommandText } from '../utils/sanitize.js';

const SYSTEM_USER = 'AutoMod';
let muteFallbackLogged = false;
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
function evaluate(
  cfg: AutoModConfig,
  player: string,
  message: string,
  now: number,
): Violation | null {
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
    return {
      rule: 'length',
      detail: `message length ${text.length} (limit ${cfg.maxMessageLength})`,
    };
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

async function enforce(
  cfg: AutoModConfig,
  player: string,
  serverId: string | undefined,
  v: Violation,
): Promise<void> {
  // The name goes into /kick and /say as-is; anything but a plain player name
  // is refused instead of being written to the console.
  if (!isValidPlayerName(player)) {
    logger.warn(
      `[AutoMod] not enforcing: invalid player name ${JSON.stringify(String(player).slice(0, 40))}`,
    );
    return;
  }
  const detail = stripControlChars(v.detail).trim();
  const reason = `AutoMod: ${detail}`;
  let action = cfg.action;
  if (action === 'mute') {
    if (!muteFallbackLogged) {
      logger.warn('[AutoMod] Hytale 0.7 has no chat mute; the "mute" action warns instead');
      muteFallbackLogged = true;
    }
    action = 'warn';
  }
  const { execCommand } = await import('./docker.js');
  try {
    const result =
      action === 'kick'
        ? await execCommand(`/kick ${player}`, serverId, { actor: 'automod' })
        : // warn — public reminder + recorded warning
          await execCommand(
            `/say [AutoMod] ${player}, please mind the chat rules (${toCommandText(detail, 120)}).`,
            serverId,
            { actor: 'automod' },
          );
    if (!result.success) {
      logger.warn(`[AutoMod] ${action} ${player} failed: ${result.error ?? 'unknown error'}`);
      await logActivity(SYSTEM_USER, `automod_${action}`, 'player', false, player, result.error);
      return;
    }
    await recordPunishment({
      serverId,
      playerName: player,
      type: action === 'kick' ? 'kick' : 'warn',
      reason,
      byUser: SYSTEM_USER,
    });
    await logActivity(SYSTEM_USER, `automod_${action}`, 'player', true, player, v.detail);
    logger.info(`[AutoMod] ${action} ${player} — ${v.detail}`);
  } catch (err) {
    logger.warn(
      `[AutoMod] enforcement failed for ${player}: ${err instanceof Error ? err.message : err}`,
    );
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
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  recentByPlayer.clear();
}
