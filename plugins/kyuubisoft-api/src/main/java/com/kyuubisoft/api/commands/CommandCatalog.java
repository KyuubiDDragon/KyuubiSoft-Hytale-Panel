package com.kyuubisoft.api.commands;

import com.hypixel.hytale.logger.HytaleLogger;
import com.hypixel.hytale.server.core.Message;
import com.hypixel.hytale.server.core.command.system.AbstractCommand;
import com.hypixel.hytale.server.core.command.system.CommandManager;
import com.hypixel.hytale.server.core.command.system.CommandOwner;
import com.hypixel.hytale.server.core.command.system.arguments.system.AbstractOptionalArg;
import com.hypixel.hytale.server.core.command.system.arguments.system.Argument;
import com.hypixel.hytale.server.core.command.system.arguments.system.DefaultArg;
import com.hypixel.hytale.server.core.command.system.arguments.system.FlagArg;
import com.hypixel.hytale.server.core.command.system.arguments.system.RequiredArg;
import com.hypixel.hytale.server.core.command.system.arguments.types.ArgumentType;
import com.hypixel.hytale.server.core.modules.i18n.I18nModule;
import com.hypixel.hytale.server.core.plugin.PluginBase;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.ConcurrentModificationException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.logging.Level;

/**
 * Exports the server's registered commands (vanilla and every mod) for the
 * panel: names, aliases, descriptions, permission nodes, owners, arguments,
 * usage variants and subcommands.
 *
 * <p>{@link #revision} is a short hash of the command structure (names,
 * aliases, permissions, owners, arguments). It changes when a plugin loads,
 * unloads or reloads its commands, so the panel can keep its copy until then.</p>
 */
final class CommandCatalog {

    private static final HytaleLogger LOGGER = HytaleLogger.get("KyuubiSoftAPI");
    private static final int MAX_DEPTH = 8;
    private static final int SNAPSHOT_ATTEMPTS = 3;
    private static final Comparator<AbstractCommand> BY_NAME =
            Comparator.comparing(c -> c.getName() == null ? "" : c.getName());

    private CommandCatalog() {
    }

    /** Full export. Reads descriptions in the server's default language. */
    static Registry export(CommandManager manager) {
        List<AbstractCommand> roots = rootCommands(manager);
        List<CommandInfo> commands = new ArrayList<>(roots.size());
        for (AbstractCommand command : roots) {
            commands.add(describe(command, "/" + command.getName(), 0));
        }
        return new Registry(revision(roots), Instant.now().toString(), commands.size(), commands);
    }

    /** Revision of the current command set, without building the export. */
    static String revision(CommandManager manager) {
        return revision(rootCommands(manager));
    }

    /**
     * The registration map is a plain hash map that plugins change while they
     * load; copy it, retrying if a registration happened in between.
     */
    static List<AbstractCommand> rootCommands(CommandManager manager) {
        for (int attempt = 1; ; attempt++) {
            try {
                List<AbstractCommand> roots = new ArrayList<>(manager.getCommandRegistration().values());
                roots.sort(BY_NAME);
                return roots;
            } catch (ConcurrentModificationException e) {
                if (attempt >= SNAPSHOT_ATTEMPTS) throw e;
                Thread.onSpinWait();
            }
        }
    }

    // ==================== export ====================

    private static CommandInfo describe(AbstractCommand command, String path, int depth) {
        CommandInfo info = new CommandInfo();
        info.name = command.getName();
        try {
            info.aliases = sortedOrNull(command.getAliases());
            info.description = translate(command.getDescription());
            info.permission = command.getPermission();
            CommandOwner owner = command.getOwner();
            info.owner = ownerName(owner);
            info.builtin = isBuiltin(owner);
            info.usage = usage(path, command.getRequiredArguments());
            info.requiredArgs = requiredArgs(command.getRequiredArguments());
            info.optionalArgs = optionalArgs(command.getOptionalArguments());
            info.variants = variants(command, path);
            if (depth < MAX_DEPTH) info.subcommands = subcommands(command, path, depth);
        } catch (RuntimeException | LinkageError e) {
            // One unreadable mod command must not hide all others.
            LOGGER.at(Level.FINE).withCause(e).log("Could not export command %s", path);
            info.error = "unreadable";
        }
        return info;
    }

    private static List<CommandInfo> subcommands(AbstractCommand command, String path, int depth) {
        Map<String, AbstractCommand> subs = command.getSubCommands();
        if (subs == null || subs.isEmpty()) return null;
        List<AbstractCommand> sorted = new ArrayList<>(subs.values());
        sorted.sort(BY_NAME);
        List<CommandInfo> out = new ArrayList<>(sorted.size());
        for (AbstractCommand sub : sorted) {
            out.add(describe(sub, path + " " + sub.getName(), depth + 1));
        }
        return out;
    }

    private static List<VariantInfo> variants(AbstractCommand command, String path) {
        Collection<AbstractCommand> variants = command.getVariantCommands();
        if (variants == null || variants.isEmpty()) return null;
        List<VariantInfo> out = new ArrayList<>(variants.size());
        for (AbstractCommand variant : variants) {
            VariantInfo info = new VariantInfo();
            info.usage = usage(path, variant.getRequiredArguments());
            info.description = translate(variant.getDescription());
            info.requiredArgs = requiredArgs(variant.getRequiredArguments());
            out.add(info);
        }
        out.sort(Comparator.comparingInt(v -> v.requiredArgs == null ? 0 : v.requiredArgs.size()));
        return out;
    }

    private static List<ArgInfo> requiredArgs(List<RequiredArg<?>> args) {
        if (args == null || args.isEmpty()) return null;
        List<ArgInfo> out = new ArrayList<>(args.size());
        for (RequiredArg<?> arg : args) {
            ArgInfo info = new ArgInfo();
            info.name = arg.getName();
            info.description = translate(arg.getDescription());
            fillType(info, arg);
            out.add(info);
        }
        return out;
    }

    private static List<OptionInfo> optionalArgs(Map<String, AbstractOptionalArg<?, ?>> args) {
        if (args == null || args.isEmpty()) return null;
        List<OptionInfo> out = new ArrayList<>(args.size());
        for (Map.Entry<String, AbstractOptionalArg<?, ?>> entry : args.entrySet()) {
            AbstractOptionalArg<?, ?> arg = entry.getValue();
            OptionInfo info = new OptionInfo();
            info.name = entry.getKey();
            info.description = translate(arg.getDescription());
            info.permission = arg.getPermission();
            info.aliases = sortedOrNull(arg.getAliases());
            if (arg instanceof FlagArg) {
                info.kind = "flag";
            } else {
                info.kind = arg instanceof DefaultArg<?> ? "default" : "optional";
                fillType(info, arg);
                if (arg instanceof DefaultArg<?> withDefault) info.defaultValue = withDefault.getDefaultValueDescription();
            }
            out.add(info);
        }
        out.sort(Comparator.comparing(o -> o.name));
        return out;
    }

    private static void fillType(ArgInfo info, Argument<?, ?> arg) {
        ArgumentType<?> type = arg.getArgumentType();
        if (type == null) return;
        Message name = type.getName();
        if (name != null) info.type = PanelCommandSender.plainText(name);
    }

    private static String usage(String path, List<RequiredArg<?>> args) {
        StringBuilder usage = new StringBuilder(path);
        if (args != null) {
            for (RequiredArg<?> arg : args) usage.append(" <").append(arg.getName()).append('>');
        }
        return usage.toString();
    }

    /** Commands store a translation key (vanilla) or plain text (some mods). */
    private static String translate(String keyOrText) {
        if (keyOrText == null || keyOrText.isBlank()) return null;
        try {
            I18nModule i18n = I18nModule.get();
            String text = i18n != null ? i18n.getMessage(I18nModule.DEFAULT_LANGUAGE, keyOrText) : null;
            return text != null ? text : keyOrText;
        } catch (RuntimeException e) {
            return keyOrText;
        }
    }

    private static String ownerName(CommandOwner owner) {
        if (owner == null) return null;
        if (owner instanceof PluginBase plugin) {
            try {
                return plugin.getIdentifier().toString();
            } catch (RuntimeException ignored) {
                // fall through to the plain name
            }
        }
        return owner.getName();
    }

    /** Registered by the server itself or one of its built-in modules (group "Hytale"). */
    private static boolean isBuiltin(CommandOwner owner) {
        if (owner == null || owner instanceof CommandManager) return true;
        if (owner instanceof PluginBase plugin) {
            try {
                return "Hytale".equalsIgnoreCase(plugin.getIdentifier().getGroup());
            } catch (RuntimeException ignored) {
                return false;
            }
        }
        return false;
    }

    private static List<String> sortedOrNull(Collection<String> values) {
        if (values == null || values.isEmpty()) return null;
        List<String> sorted = new ArrayList<>(values);
        sorted.sort(null);
        return sorted;
    }

    // ==================== revision ====================

    static String revision(List<AbstractCommand> roots) {
        MessageDigest digest = sha256();
        for (AbstractCommand command : roots) fingerprint(digest, command, 0);
        return HexFormat.of().formatHex(digest.digest(), 0, 8);
    }

    private static void fingerprint(MessageDigest digest, AbstractCommand command, int depth) {
        update(digest, "c", command.getName());
        try {
            for (String alias : orEmpty(sortedOrNull(command.getAliases()))) update(digest, "a", alias);
            update(digest, "p", command.getPermission());
            update(digest, "o", ownerName(command.getOwner()));
            List<RequiredArg<?>> required = command.getRequiredArguments();
            if (required != null) {
                for (RequiredArg<?> arg : required) update(digest, "r", arg.getName());
            }
            Map<String, AbstractOptionalArg<?, ?>> optional = command.getOptionalArguments();
            if (optional != null) {
                List<String> names = new ArrayList<>(optional.keySet());
                names.sort(null);
                for (String name : names) update(digest, "f", name);
            }
            Collection<AbstractCommand> variants = command.getVariantCommands();
            if (variants != null) update(digest, "v", String.valueOf(variants.size()));
            Map<String, AbstractCommand> subs = command.getSubCommands();
            if (subs != null && depth < MAX_DEPTH) {
                List<AbstractCommand> sorted = new ArrayList<>(subs.values());
                sorted.sort(BY_NAME);
                update(digest, "{", null);
                for (AbstractCommand sub : sorted) fingerprint(digest, sub, depth + 1);
                update(digest, "}", null);
            }
        } catch (RuntimeException | LinkageError e) {
            update(digest, "x", null);
        }
    }

    private static void update(MessageDigest digest, String tag, String value) {
        digest.update(tag.getBytes(StandardCharsets.UTF_8));
        if (value != null) digest.update(value.getBytes(StandardCharsets.UTF_8));
        digest.update((byte) 0);
    }

    private static <T> List<T> orEmpty(List<T> list) {
        return list == null ? List.of() : list;
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    // ==================== JSON shapes (Gson, null fields are omitted) ====================

    /** {@code GET /api/commands}. */
    static final class Registry {
        final String revision;
        final String generatedAt;
        final int count;
        final List<CommandInfo> commands;

        Registry(String revision, String generatedAt, int count, List<CommandInfo> commands) {
            this.revision = revision;
            this.generatedAt = generatedAt;
            this.count = count;
            this.commands = commands;
        }
    }

    static final class CommandInfo {
        String name;
        List<String> aliases;
        String description;
        String permission;
        String owner;
        Boolean builtin;
        String usage;
        List<ArgInfo> requiredArgs;
        List<OptionInfo> optionalArgs;
        List<VariantInfo> variants;
        List<CommandInfo> subcommands;
        String error;
    }

    static class ArgInfo {
        String name;
        String type;
        String description;
    }

    /** {@code kind}: "optional" ({@code --name=value}), "default" (has a default) or "flag" ({@code --name}). */
    static final class OptionInfo extends ArgInfo {
        String kind;
        String permission;
        List<String> aliases;
        String defaultValue;
    }

    static final class VariantInfo {
        String usage;
        String description;
        List<ArgInfo> requiredArgs;
    }
}
