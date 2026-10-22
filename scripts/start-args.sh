# shellcheck shell=bash
# ============================================================
# Checks for the start parameters stored in panel-config.json
# ============================================================
# Sourced by start-server.sh; defines functions only.
#
# The panel refuses the same values when they are saved
# (manager/backend/src/services/jvmSettings.ts). The start script checks them
# again because a value saved by an older panel version, or written into
# panel-config.json by hand, would otherwise reach Java unchecked - including
# options that load code (-javaagent, @argfiles) or overwrite files in the
# server directory. Keep both in line: jvmSettings.script.test.ts runs them
# against the same cases.
#
# Every check prints why a value is refused and returns 1; 0 = accepted.

PANEL_ARGS_MAX_LENGTH=1024
PANEL_RAM_VALUE='^[0-9]{1,5}[MmGg]$'

# "3G" / "512M", like the panel's RAM fields.
check_panel_ram() {
    local LC_ALL=C
    [[ "$1" =~ $PANEL_RAM_VALUE ]] && return 0
    echo "\"$1\" is not a RAM size like 3G or 512M"
    return 1
}

# ---------- JVM arguments ----------

# The only forms accepted at all.
PANEL_JAVA_FORMS=(
    '^-XX:[+-][A-Za-z][A-Za-z0-9_]*$'
    '^-XX:[A-Za-z][A-Za-z0-9_]*=[A-Za-z0-9_.:+,%-]*$'
    '^-D[A-Za-z_][A-Za-z0-9_.-]*(=[A-Za-z0-9_.:+/,%-]*)?$'
    '^-Xss[0-9]+[kKmM]?$'
    '^-Xmn[0-9]+[kKmMgG]?$'
    '^-Xlog:[A-Za-z0-9_*+=:,./%-]+$'
    '^-verbose:(gc|class|module|jni)$'
    '^--(add-opens|add-exports|add-reads|enable-native-access)=[A-Za-z0-9_./,=-]+$'
    '^-(ea|da|esa|dsa)$'
)

# Matched against the lower-cased token: code loading, files at a chosen path,
# the heap the panel manages, SIGTERM handling.
PANEL_JAVA_HEAP='^-x(mx|ms)'
PANEL_JAVA_CODE_LOADING='^(-javaagent|-agent(lib|path)|-xbootclasspath|@)'
PANEL_JAVA_BLOCKED_XX='^-xx:[+-]?(onerror|onoutofmemoryerror|vmoptionsfile|flags|compilecommandfile|aot[a-z0-9_]*|sharedarchivefile|sharedclasslistfile|extrasharedclasslistfile|archiveclassesatexit|dumploadedclasslist|unlock[a-z0-9_]+vmoptions|[a-z0-9_]*jvmci[a-z0-9_]*|errorfile|heapdumppath|logfile|logcompilation|logvmoutput|startflightrecording|flightrecorderoptions|perfdatasavefile|allocateheapat|reducesignalusage|maxheapsize|initialheapsize|minheapsize|[a-z0-9_]*rampercentage|maxram[a-z0-9_]*|minram[a-z0-9_]*|initialram[a-z0-9_]*)(=|$)'
# -D: only the server's own properties and a few harmless Java ones (others
# include library paths a native library is loaded from). Case-sensitive.
PANEL_JAVA_ALLOWED_PROPERTY='^-D(hytale\.[A-Za-z0-9_.-]+|file\.encoding|java\.net\.preferIPv4Stack|java\.net\.preferIPv6Addresses|java\.awt\.headless|sun\.net\.[A-Za-z0-9_]+|jdk\.virtualThreadScheduler\.[A-Za-z0-9_]+)(=|$)'
PANEL_JAVA_UNSUPPORTED_GC='^-xx:[+-]?use(epsilon|concmarksweep|parallelold)gc$'
PANEL_JAVA_GC_SELECTOR='^-XX:\+Use(Serial|Parallel|G1|Z|Shenandoah)GC$'
# -Xlog output: stdout, stderr or a file in the server's logs folder (Java
# treats any other output as a file name, with or without "file=").
PANEL_JAVA_XLOG_OUTPUT='^(stdout|stderr|(file=)?logs/[A-Za-z0-9_%-][A-Za-z0-9_.%-]*)$'

check_panel_java_args() {
    local LC_ALL=C
    local token lower form known rest what output colons collectors=" "
    local -a tokens
    if [ "${#1}" -gt "$PANEL_ARGS_MAX_LENGTH" ]; then
        echo "Java arguments are too long"
        return 1
    fi
    read -ra tokens <<< "$1"
    for token in "${tokens[@]}"; do
        lower="${token,,}"
        if [[ "$lower" =~ $PANEL_JAVA_HEAP ]]; then
            echo "\"$token\": the heap is set with the RAM fields"
            return 1
        fi
        if [[ "$lower" =~ $PANEL_JAVA_CODE_LOADING ]] || [[ "$lower" =~ $PANEL_JAVA_BLOCKED_XX ]]; then
            echo "\"$token\" loads code, writes files or changes the runtime or the heap"
            return 1
        fi
        if [[ "$token" == -D* ]] && ! [[ "$token" =~ $PANEL_JAVA_ALLOWED_PROPERTY ]]; then
            echo "\"$token\": only -Dhytale.* and a few Java properties can be set from the panel"
            return 1
        fi
        if [[ "$lower" =~ $PANEL_JAVA_UNSUPPORTED_GC ]]; then
            echo "\"$token\": this garbage collector does not exist in Java 25 or never frees memory"
            return 1
        fi
        known=0
        for form in "${PANEL_JAVA_FORMS[@]}"; do
            if [[ "$token" =~ $form ]]; then
                known=1
                break
            fi
        done
        if [ "$known" = 0 ]; then
            echo "\"$token\" is not an accepted JVM option"
            return 1
        fi
        if [[ "$token" == -Xlog:* ]]; then
            # -Xlog:<what>:<output>:<decorators>:<output-options>
            rest="${token#-Xlog:}"
            what="${rest%%:*}"
            output=""
            [[ "$rest" == *:* ]] && output="${rest#*:}" && output="${output%%:*}"
            colons="${rest//[^:]/}"
            if [ "${what,,}" = "help" ]; then
                echo "\"$token\": -Xlog:help only prints and exits"
                return 1
            fi
            if [ "${#colons}" -gt 3 ] || { [ -n "$output" ] && ! [[ "$output" =~ $PANEL_JAVA_XLOG_OUTPUT ]]; }; then
                echo "\"$token\": -Xlog may only write to logs/<file>"
                return 1
            fi
        fi
        if [[ "$token" =~ $PANEL_JAVA_GC_SELECTOR ]] && [[ "$collectors" != *" ${BASH_REMATCH[1]} "* ]]; then
            collectors+="${BASH_REMATCH[1]} "
        fi
    done
    read -ra tokens <<< "$collectors"
    if [ "${#tokens[@]}" -gt 1 ]; then
        echo "Only one garbage collector can be selected"
        return 1
    fi
    return 0
}

# Does the argument list pick a collector other than G1 (the start script's)?
panel_selects_collector() {
    local LC_ALL=C arg
    for arg in "$@"; do
        [[ "$arg" =~ $PANEL_JAVA_GC_SELECTOR ]] && [ "${BASH_REMATCH[1]}" != "G1" ] && return 0
    done
    return 1
}

# ---------- server arguments ----------

# The server options that may be used in the extra arguments and how they
# take a value: flag, value, or optional (the next word, unless it is an
# option). Options the panel sets itself or that make a hosted server exit
# are left out, so they are refused like unknown ones.
declare -A PANEL_SERVER_OPTIONS=(
    [allow-install-dir]=flag
    [disable-asset-compare]=flag
    [disable-cpb-build]=flag
    [disable-file-watcher]=flag
    [event-debug]=flag
    [force-network-flush]=value
    [ignore-broken-mods]=flag
    [log]=value
    [prefab-cache]=value
    [transport]=value
    [validate-assets]=flag
    [validate-prefabs]=optional
    [validate-world-gen]=flag
    [world-gen]=value
)

PANEL_SERVER_SAFE_TOKEN='^[A-Za-z0-9_.:=+/,*%$-]+$'
PANEL_SERVER_SHORT_OPTION='^-[A-Za-z]$'
# Value patterns; the log levels and true/false are matched lower-cased.
PANEL_SERVER_PATH_VALUE='^/opt/hytale/[A-Za-z0-9_./-]+$'
PANEL_SERVER_DOTDOT_SEGMENT='/\.\.(/|$)'
PANEL_SERVER_BOOL_VALUE='^(true|false)$'
PANEL_SERVER_LOG_VALUE='^([a-z0-9_.$-]+:)?(off|severe|warning|info|config|fine|finer|finest|all)(,([a-z0-9_.$-]+:)?(off|severe|warning|info|config|fine|finer|finest|all))*$'
PANEL_SERVER_TRANSPORT_VALUE='^(QUIC|QUICHE)$'
PANEL_SERVER_VALIDATION_VALUE='^(PHYSICS|BLOCKS|BLOCK_STATES|ENTITIES|BLOCK_FILLER)(,(PHYSICS|BLOCKS|BLOCK_STATES|ENTITIES|BLOCK_FILLER))*$'

# Value $2 of option $1.
panel_server_value_ok() {
    local LC_ALL=C
    local value="$2"
    case "$1" in
        prefab-cache | world-gen)
            # An absolute path below /opt/hytale without ".." segments
            [[ "$value" =~ $PANEL_SERVER_PATH_VALUE ]] \
                && ! [[ "/${value#/opt/hytale/}" =~ $PANEL_SERVER_DOTDOT_SEGMENT ]]
            ;;
        force-network-flush) [[ "${value,,}" =~ $PANEL_SERVER_BOOL_VALUE ]] ;;
        log) [[ "${value,,}" =~ $PANEL_SERVER_LOG_VALUE ]] ;;
        transport) [[ "$value" =~ $PANEL_SERVER_TRANSPORT_VALUE ]] ;;
        validate-prefabs) [[ "$value" =~ $PANEL_SERVER_VALIDATION_VALUE ]] ;;
        *) return 1 ;;
    esac
}

check_panel_server_args() {
    local LC_ALL=C
    local i token name kind value has_value
    local -a tokens
    if [ "${#1}" -gt "$PANEL_ARGS_MAX_LENGTH" ]; then
        echo "Server arguments are too long"
        return 1
    fi
    read -ra tokens <<< "$1"
    for ((i = 0; i < ${#tokens[@]}; i++)); do
        token="${tokens[i]}"
        if ! [[ "$token" =~ $PANEL_SERVER_SAFE_TOKEN ]]; then
            echo "Invalid characters in \"$token\""
            return 1
        fi
        has_value=0
        value=""
        if [[ "$token" == --* ]]; then
            name="${token#--}"
            if [[ "$name" == *=* ]]; then
                value="${name#*=}"
                name="${name%%=*}"
                has_value=1
            fi
        elif [[ "$token" =~ $PANEL_SERVER_SHORT_OPTION ]]; then
            name="$token"
            [ "$token" = "-t" ] && name="transport"
        else
            echo "\"$token\" is not an option"
            return 1
        fi
        kind=""
        [ -n "$name" ] && kind="${PANEL_SERVER_OPTIONS[$name]:-}"
        if [ -z "$kind" ]; then
            echo "\"$token\" is unknown, set by the panel or not allowed for a hosted server"
            return 1
        fi
        if [ "$kind" = "flag" ] && [ "$has_value" = 1 ]; then
            echo "\"--$name\" does not take a value"
            return 1
        fi
        if [ "$kind" = "value" ] && [ "$has_value" = 0 ]; then
            if [ $((i + 1)) -ge "${#tokens[@]}" ]; then
                echo "\"--$name\" needs a value"
                return 1
            fi
            i=$((i + 1))
            value="${tokens[i]}"
            has_value=1
        fi
        if [ "$kind" = "optional" ] && [ "$has_value" = 0 ] && [ $((i + 1)) -lt "${#tokens[@]}" ] \
            && [[ "${tokens[i + 1]}" != -* ]]; then
            i=$((i + 1))
            value="${tokens[i]}"
            has_value=1
        fi
        if [ "$has_value" = 1 ] && ! panel_server_value_ok "$name" "$value"; then
            echo "Invalid value \"$value\" for \"--$name\""
            return 1
        fi
    done
    return 0
}
