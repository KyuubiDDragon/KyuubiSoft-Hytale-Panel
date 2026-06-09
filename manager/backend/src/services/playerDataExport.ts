/**
 * Player data export + erasure (GDPR / DSGVO subject requests).
 *
 * Aggregates everything the panel stores about one player into a single JSON
 * document (Art. 15 / 20 — access & portability), and can erase that data
 * (Art. 17 — right to be forgotten).
 *
 * Sources:
 *   - player_notes      (SQLite)  staff notes
 *   - punishments       (SQLite)  bans/kicks/mutes/warns
 *   - play_sessions     (SQLite)  join/leave sessions + totals
 *   - per-player chat    (files)   chat history + death positions
 *
 * The on-disk Hytale player save file (inventory/stats) is the GAME's data, not
 * the panel's, so it is referenced but not deleted here — removing it would
 * corrupt the world. Operators delete it via the game if required.
 */
import { getDb } from '../db/index.js';
import { listNotes, type PlayerNote } from './playerNotes.js';
import { listPunishments, type Punishment } from './punishments.js';
import { getPlayerChatLog, deletePlayerChatData, type ChatMessage } from './chatLog.js';
import { isDemoMode } from './demoData.js';

export interface PlayerSessionRow {
  player_name: string;
  uuid: string | null;
  joined_at: string;
  left_at: string | null;
  duration_ms: number | null;
  server_id: string | null;
}

export interface PlayerDataExport {
  player: string;
  generatedAt: string;
  notes: PlayerNote[];
  punishments: Punishment[];
  playSessions: PlayerSessionRow[];
  playtimeSummary: { totalSessions: number; totalMs: number };
  chat: ChatMessage[];
  uuids: string[];
}

function querySessions(playerName: string): PlayerSessionRow[] {
  try {
    return getDb()
      .prepare('SELECT player_name, uuid, joined_at, left_at, duration_ms, server_id FROM play_sessions WHERE player_name = ? ORDER BY joined_at DESC')
      .all(playerName) as PlayerSessionRow[];
  } catch {
    return [];
  }
}

export async function exportPlayerData(playerName: string): Promise<PlayerDataExport> {
  if (isDemoMode()) {
    return {
      player: playerName,
      generatedAt: new Date().toISOString(),
      notes: [],
      punishments: [],
      playSessions: [],
      playtimeSummary: { totalSessions: 0, totalMs: 0 },
      chat: [],
      uuids: [],
    };
  }

  const notes = listNotes(playerName, 10_000);
  const punishments = listPunishments({ player: playerName, limit: 10_000 });
  const playSessions = querySessions(playerName);
  const chatResult = await getPlayerChatLog(playerName, { days: 0, limit: 100_000 });

  const totalMs = playSessions.reduce((sum, s) => sum + (s.duration_ms || 0), 0);
  const uuids = Array.from(new Set(
    [...playSessions.map(s => s.uuid), ...notes.map(n => n.uuid ?? null), ...punishments.map(p => p.uuid ?? null)]
      .filter((u): u is string => !!u)
  ));

  return {
    player: playerName,
    generatedAt: new Date().toISOString(),
    notes,
    punishments,
    playSessions,
    playtimeSummary: { totalSessions: playSessions.length, totalMs },
    chat: chatResult.messages,
    uuids,
  };
}

export interface ErasureResult {
  player: string;
  deleted: { notes: number; punishments: number; playSessions: number; chat: boolean };
}

/**
 * Erase the panel's personal data for a player. SQLite deletes are exact on
 * player_name; chat is removed via the chat service. Idempotent.
 */
export async function deletePlayerData(playerName: string): Promise<ErasureResult> {
  if (isDemoMode()) {
    return { player: playerName, deleted: { notes: 0, punishments: 0, playSessions: 0, chat: true } };
  }
  const db = getDb();
  let notes = 0;
  let punishments = 0;
  let playSessions = 0;
  try { notes = db.prepare('DELETE FROM player_notes WHERE player_name = ?').run(playerName).changes; } catch { /* table may not exist */ }
  try { punishments = db.prepare('DELETE FROM punishments WHERE player_name = ?').run(playerName).changes; } catch { /* ignore */ }
  try { playSessions = db.prepare('DELETE FROM play_sessions WHERE player_name = ?').run(playerName).changes; } catch { /* ignore */ }
  const chat = await deletePlayerChatData(playerName);

  return { player: playerName, deleted: { notes, punishments, playSessions, chat } };
}
