package com.kyuubisoft.api.live;

import com.hypixel.hytale.server.core.modules.accesscontrol.AccessControlModule;
import com.hypixel.hytale.server.core.permissions.PermissionsModule;
import com.hypixel.hytale.server.core.permissions.provider.HytalePermissionsProvider;
import com.hypixel.hytale.server.core.permissions.provider.PermissionProvider;
import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * GET /api/permissions/groups, /api/permissions/users and
 * /api/permissions/users/{uuid}, read from the running permissions module.
 *
 * <p>The module keeps its state as an immutable snapshot, so these reads are
 * safe off the world threads. It has no "list every user" call: the user list
 * covers online players, whitelisted users and users with direct wildcard or
 * operator rights. Any other user can be looked up by UUID.</p>
 */
public final class PermissionsCollector {

    private static final String WILDCARD = "*";

    /** Null when the permissions module is not loaded (then the route answers 501). */
    public Groups groups() {
        PermissionsModule module = module();
        if (module == null) return null;
        Groups groups = new Groups();
        groups.defaultGroup = HytalePermissionsProvider.DEFAULT_GROUP;
        groups.operatorGroup = HytalePermissionsProvider.GROUP_ADMIN;
        groups.providers = new ArrayList<>();
        List<PermissionProvider> providers = module.getProviders();
        for (PermissionProvider provider : providers) groups.providers.add(provider.getName());
        groups.providersTampered = module.areProvidersTampered();

        groups.groups = new ArrayList<>();
        for (String name : LiveFormat.sorted(module.getAllRegisteredGroups())) {
            groups.groups.add(describeGroup(name, providers));
        }
        groups.virtualGroups = new LinkedHashMap<>();
        Map<String, Set<String>> virtual = module.getVirtualGroups();
        if (virtual != null) {
            for (String name : LiveFormat.sorted(virtual.keySet())) {
                groups.virtualGroups.put(name, LiveFormat.sorted(virtual.get(name)));
            }
        }
        groups.count = groups.groups.size();
        return groups;
    }

    /** Null when the permissions module is not loaded (then the route answers 501). */
    public Users users() {
        PermissionsModule module = module();
        if (module == null) return null;
        Set<UUID> known = new LinkedHashSet<>();
        for (PlayerRef ref : Universe.get().getPlayers()) known.add(ref.getUuid());
        AccessControlModule access = access();
        if (access != null) {
            Set<UUID> granted = access.getUsersWithJoinGrant();
            if (granted != null) known.addAll(granted);
        }
        Set<UUID> wildcard = module.getUsersWithPermission(WILDCARD);
        if (wildcard != null) known.addAll(wildcard);

        Users users = new Users();
        users.users = new ArrayList<>();
        for (UUID uuid : known) users.users.add(describeUser(uuid, module, access));
        users.users.sort(Comparator.comparing((UserInfo u) -> !u.online)
                .thenComparing(u -> u.name == null ? u.uuid : u.name, String.CASE_INSENSITIVE_ORDER));
        users.count = users.users.size();
        users.complete = false;
        return users;
    }

    /** Null when the permissions module is not loaded (then the route answers 501). */
    public UserInfo user(UUID uuid) {
        PermissionsModule module = module();
        if (module == null) return null;
        return describeUser(uuid, module, access());
    }

    private static GroupInfo describeGroup(String name, List<PermissionProvider> providers) {
        GroupInfo group = new GroupInfo();
        group.name = name;
        Set<String> direct = new LinkedHashSet<>();
        Set<String> effective = new LinkedHashSet<>();
        for (PermissionProvider provider : providers) {
            Set<String> own = provider.getGroupPermissions(name);
            if (own != null) direct.addAll(own);
            Set<String> all = provider.getEffectiveGroupPermissions(name);
            if (all != null) effective.addAll(all);
            if (group.parent == null) group.parent = provider.getGroupParent(name);
        }
        group.permissions = LiveFormat.sorted(direct);
        group.effectivePermissions = LiveFormat.sorted(effective);
        return group;
    }

    private static UserInfo describeUser(UUID uuid, PermissionsModule module, AccessControlModule access) {
        UserInfo user = new UserInfo();
        user.uuid = uuid.toString();
        user.name = LiveFormat.onlineName(uuid);
        user.online = user.name != null;
        user.groups = LiveFormat.sorted(module.getGroupsForUser(uuid));
        Set<String> direct = new LinkedHashSet<>();
        for (PermissionProvider provider : module.getProviders()) {
            Set<String> own = provider.getUserPermissions(uuid);
            if (own != null) direct.addAll(own);
        }
        user.permissions = LiveFormat.sorted(direct);
        user.operator = user.groups.contains(HytalePermissionsProvider.GROUP_ADMIN)
                || direct.contains(WILDCARD);
        String join = AccessCollector.joinPermission();
        if (join != null) user.joinGrant = module.hasUserGrant(uuid, join);
        if (access != null) {
            user.allowedToJoin = access.isAllowedToJoin(uuid);
            user.banned = access.isBanned(uuid);
        }
        return user;
    }

    private static PermissionsModule module() {
        try {
            return PermissionsModule.get();
        } catch (Throwable t) {
            return null;
        }
    }

    private static AccessControlModule access() {
        try {
            return AccessControlModule.get();
        } catch (Throwable t) {
            return null;
        }
    }

    // Response classes (Gson omits null fields).

    public static class Groups {
        public String defaultGroup;
        public String operatorGroup;
        public List<String> providers;
        public boolean providersTampered;
        public int count;
        public List<GroupInfo> groups;
        public Map<String, List<String>> virtualGroups;
    }

    public static class GroupInfo {
        public String name;
        public String parent;
        public List<String> permissions;
        public List<String> effectivePermissions;
    }

    public static class Users {
        /** False: the module cannot enumerate every user, see the class comment. */
        public boolean complete;
        public int count;
        public List<UserInfo> users;
    }

    public static class UserInfo {
        public String uuid;
        public String name;
        public boolean online;
        public List<String> groups;
        public List<String> permissions;
        public boolean operator;
        public Boolean joinGrant;
        public Boolean allowedToJoin;
        public Boolean banned;
    }
}
