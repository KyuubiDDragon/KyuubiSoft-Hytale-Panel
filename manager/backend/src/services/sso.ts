/**
 * SSO providers.
 *
 * Discord (OAuth2, not strictly OIDC — uses `/users/@me` as identity) ships
 * first because the project's community lives on Discord. The provider
 * interface is shaped so a generic OIDC adapter (openid-client) can be added
 * later without changing the route layer.
 *
 * Configuration lives in /app/data/config.json under `sso.providers[]`:
 *
 *   {
 *     "sso": {
 *       "enabled": true,
 *       "providers": [{
 *         "id": "discord",
 *         "type": "discord",
 *         "clientId": "...",
 *         "clientSecret": "...",
 *         "allowedGuildIds": ["..."],
 *         "defaultRoleId": "viewer",
 *         "autoCreate": true
 *       }]
 *     }
 *   }
 */
import { readFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export interface SsoProviderConfig {
  id: string;
  type: 'discord' | 'oidc';
  clientId: string;
  clientSecret: string;
  // Discord-only
  allowedGuildIds?: string[];
  // Generic OIDC
  issuer?: string;
  scopes?: string[];
  defaultRoleId?: string;
  autoCreate?: boolean;
}

interface SsoConfig { enabled: boolean; providers: SsoProviderConfig[] }

async function readSsoConfig(): Promise<SsoConfig> {
  try {
    const data = JSON.parse(await readFile(CONFIG_FILE, 'utf-8')) as { sso?: SsoConfig };
    return data.sso ?? { enabled: false, providers: [] };
  } catch {
    return { enabled: false, providers: [] };
  }
}

export async function listProviders(): Promise<Array<{ id: string; type: string }>> {
  const cfg = await readSsoConfig();
  if (!cfg.enabled) return [];
  return cfg.providers.map(p => ({ id: p.id, type: p.type }));
}

export async function getProvider(id: string): Promise<SsoProviderConfig | null> {
  const cfg = await readSsoConfig();
  if (!cfg.enabled) return null;
  return cfg.providers.find(p => p.id === id) ?? null;
}

// State store — short-lived random tokens to defend the OAuth callback
// against CSRF. Single process, in-memory; OAuth round-trips finish in
// seconds so a Map is fine.
const stateStore = new Map<string, { providerId: string; createdAt: number; linkUsername?: string }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of stateStore.entries()) {
    if (now - v.createdAt > 5 * 60_000) stateStore.delete(k);
  }
}, 60_000).unref?.();

export function issueState(providerId: string, linkUsername?: string): string {
  const state = crypto.randomBytes(16).toString('base64url');
  stateStore.set(state, { providerId, createdAt: Date.now(), linkUsername });
  return state;
}
export function consumeState(state: string, providerId: string): { ok: boolean; linkUsername?: string } {
  const entry = stateStore.get(state);
  if (!entry || entry.providerId !== providerId) return { ok: false };
  stateStore.delete(state);
  if (Date.now() - entry.createdAt > 5 * 60_000) return { ok: false };
  return { ok: true, linkUsername: entry.linkUsername };
}

// ---------- Discord adapter ----------

export function discordAuthorizeUrl(provider: SsoProviderConfig, redirectUri: string, state: string): string {
  const scope = ['identify'];
  if (provider.allowedGuildIds?.length) scope.push('guilds');
  const params = new URLSearchParams({
    client_id: provider.clientId,
    response_type: 'code',
    scope: scope.join(' '),
    redirect_uri: redirectUri,
    state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

interface DiscordTokenResponse { access_token: string; token_type: string; expires_in: number }
interface DiscordUser { id: string; username: string; global_name?: string }
interface DiscordGuild { id: string }

export async function discordExchangeAndIdentify(
  provider: SsoProviderConfig,
  redirectUri: string,
  code: string,
): Promise<{ providerSubject: string; suggestedUsername: string } | { error: string }> {
  const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenResp.ok) return { error: `token exchange failed: ${tokenResp.status}` };
  const tok = (await tokenResp.json()) as DiscordTokenResponse;

  const meResp = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  if (!meResp.ok) return { error: `identify failed: ${meResp.status}` };
  const me = (await meResp.json()) as DiscordUser;

  // Optional guild gating
  if (provider.allowedGuildIds?.length) {
    const guildsResp = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!guildsResp.ok) return { error: 'guild list failed' };
    const guilds = (await guildsResp.json()) as DiscordGuild[];
    const allowed = guilds.some(g => provider.allowedGuildIds!.includes(g.id));
    if (!allowed) return { error: 'not a member of any allowed guild' };
  }

  return {
    providerSubject: me.id,
    suggestedUsername: (me.global_name ?? me.username).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || `discord-${me.id.slice(-8)}`,
  };
}
