package com.kyuubisoft.api.live;

import com.hypixel.hytale.server.core.modules.accesscontrol.AccessControlModule;
import com.hypixel.hytale.server.core.modules.accesscontrol.ban.Ban;
import com.hypixel.hytale.server.core.modules.accesscontrol.provider.BanProvider;
import com.hypixel.hytale.server.core.permissions.HytalePermissions;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * GET /api/access/whitelist and /api/access/bans, read from the running
 * access-control module instead of the files.
 *
 * <p>Since 0.7 the whitelist is the join permission: "enabled" is the server's
 * RequireJoinPermission flag and the entries are the users holding the join
 * grant directly (the old whitelist.json is migrated away on start). Members
 * of groups with a wildcard, e.g. the Admin group, may join without an entry.</p>
 *
 * <p>Read-only. Changes go through the server commands (/whitelist, /ban,
 * /unban) so the server stays the single writer.</p>
 */
public final class AccessCollector {

    /** The permission node 0.7 uses as whitelist entry. */
    static String joinPermission() {
        try {
            return HytalePermissions.SERVER_JOIN.getId();
        } catch (Throwable t) {
            return null;
        }
    }

    /** Null when the access-control module is not loaded (then the route answers 501). */
    public Whitelist whitelist() {
        AccessControlModule module = module();
        if (module == null) return null;
        Whitelist whitelist = new Whitelist();
        whitelist.enabled = module.isJoinPermissionRequired();
        whitelist.permission = joinPermission();
        whitelist.entries = new ArrayList<>();
        Set<UUID> granted = module.getUsersWithJoinGrant();
        if (granted != null) {
            for (UUID uuid : granted) {
                WhitelistEntry entry = new WhitelistEntry();
                entry.uuid = uuid.toString();
                entry.name = LiveFormat.onlineName(uuid);
                entry.online = entry.name != null;
                whitelist.entries.add(entry);
            }
        }
        whitelist.entries.sort(Comparator.comparing((WhitelistEntry e) -> e.name == null)
                .thenComparing(e -> e.name == null ? e.uuid : e.name, String.CASE_INSENSITIVE_ORDER));
        whitelist.count = whitelist.entries.size();
        return whitelist;
    }

    /** Null when the access-control module is not loaded (then the route answers 501). */
    public Bans bans() {
        AccessControlModule module = module();
        if (module == null) return null;
        Bans bans = new Bans();
        bans.entries = new ArrayList<>();
        BanProvider provider = module.getBanProvider();
        if (provider == null) return bans;
        bans.provider = provider.getClass().getSimpleName();
        Collection<Ban> all = provider.getBans();
        if (all != null) {
            Instant now = Instant.now();
            for (Ban ban : all) {
                if (ban != null) bans.entries.add(describe(ban, now));
            }
        }
        bans.entries.sort(Comparator.comparing((BanEntry b) -> b.timestamp == null ? "" : b.timestamp).reversed());
        bans.count = bans.entries.size();
        for (BanEntry entry : bans.entries) {
            if (entry.inEffect) bans.activeCount++;
        }
        return bans;
    }

    private static BanEntry describe(Ban ban, Instant now) {
        BanEntry entry = new BanEntry();
        entry.target = LiveFormat.uuid(ban.getTarget());
        entry.targetName = LiveFormat.onlineName(ban.getTarget());
        entry.by = LiveFormat.uuid(ban.getBy());
        entry.byName = LiveFormat.onlineName(ban.getBy());
        entry.timestamp = LiveFormat.iso(ban.getTimestamp());
        entry.expiresOn = LiveFormat.iso(ban.getExpiresOn());
        entry.permanent = ban.getExpiresOn() == null;
        entry.reason = LiveFormat.clip(ban.getReason());
        try {
            entry.inEffect = ban.isInEffect();
        } catch (Throwable t) {
            entry.inEffect = ban.getExpiresOn() == null || ban.getExpiresOn().isAfter(now);
        }
        return entry;
    }

    private static AccessControlModule module() {
        try {
            return AccessControlModule.get();
        } catch (Throwable t) {
            return null;
        }
    }

    // Response classes (Gson omits null fields).

    public static class Whitelist {
        public boolean enabled;
        public String permission;
        public int count;
        public List<WhitelistEntry> entries;
    }

    public static class WhitelistEntry {
        public String uuid;
        public String name;
        public boolean online;
    }

    public static class Bans {
        public String provider;
        public int count;
        public int activeCount;
        public List<BanEntry> entries;
    }

    public static class BanEntry {
        public String target;
        public String targetName;
        public String by;
        public String byName;
        public String timestamp;
        public String expiresOn;
        public boolean permanent;
        public boolean inEffect;
        public String reason;
    }
}
