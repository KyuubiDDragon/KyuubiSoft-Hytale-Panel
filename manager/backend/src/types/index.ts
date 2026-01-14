import { Request } from 'express';

// Auth Types
export interface LoginRequest {
  username: string;
  password: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface JwtPayload {
  sub: string;
  type: 'access' | 'refresh';
  iat: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  user?: string;
}

// Server Types
export interface ServerStatus {
  status: string;
  running: boolean;
  id?: string;
  name?: string;
  created?: string;
  started_at?: string;
  error?: string;
}

export interface ServerStats {
  cpu_percent?: number;
  memory_bytes?: number;
  memory_limit_bytes?: number;
  memory_percent?: number;
  memory_mb?: number;
  memory_limit_mb?: number;
  error?: string;
}

export interface ActionResponse {
  success: boolean;
  message?: string;
  error?: string;
  output?: string;
}

// Console Types
export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  raw?: string;
}

export interface LogsResponse {
  logs: LogEntry[];
  count: number;
}

// Backup Types
export interface BackupInfo {
  id: string;
  filename: string;
  size_bytes: number;
  size_mb: number;
  created_at: string;
  type: 'manual' | 'auto';
}

export interface StorageInfo {
  total_size_bytes: number;
  total_size_mb: number;
  backup_count: number;
}

export interface BackupListResponse {
  backups: BackupInfo[];
  storage: StorageInfo;
}

// Player Types
export interface PlayerInfo {
  name: string;
  joined_at: string;
  session_duration_seconds: number;
  session_duration: string;
}

export interface PlayersResponse {
  players: PlayerInfo[];
  count: number;
}

// WebSocket Types
export interface WsMessage {
  type: string;
  payload?: string;
}

export interface WsLogMessage {
  type: 'log';
  timestamp: string;
  level: string;
  message: string;
}

export interface WsPlayerEvent {
  type: 'player_event';
  event: 'join' | 'leave';
  player: string;
  timestamp: string;
}
