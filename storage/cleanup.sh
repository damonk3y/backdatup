#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Use BACKDATUP_ENV_FILE if set (from web UI), otherwise fall back to .env
ENV_FILE="${BACKDATUP_ENV_FILE:-$PROJECT_ROOT/.env}"

if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} .env file not found at ${CYAN}$ENV_FILE${NC} 😱"
    exit 1
fi

source "$ENV_FILE"

if [ -z "${RAID_PATH}" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} RAID_PATH environment variable is not set ⚠️"
    exit 1
fi

if [ -z "${ENVIRONMENT}" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} ENVIRONMENT variable is not set ⚠️"
    exit 1
fi

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "prod" ]]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} ENVIRONMENT must be ${YELLOW}staging${NC} or ${YELLOW}prod${NC} ⚠️"
    exit 1
fi

BACKUP_ROOT="${RAID_PATH}/backthatup/$ENVIRONMENT"
PSQL_TARGET_DIR="${BACKUP_ROOT}/psql"
MINIO_TARGET_DIR="${BACKUP_ROOT}/minio"

# BACKUP_TYPE scopes which backups to clean: psql, minio, or full (default)
BACKUP_TYPE="${BACKUP_TYPE:-full}"

if [ ! -d "$RAID_PATH" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} RAID mount path not found: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

if [ ! -w "$RAID_PATH" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} RAID mount path is not writable: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

HAS_PSQL=false
HAS_MINIO=false

if [ -d "$PSQL_TARGET_DIR" ] && [ "$BACKUP_TYPE" != "minio" ]; then
    HAS_PSQL=true
fi

if [ -d "$MINIO_TARGET_DIR" ] && [ "$BACKUP_TYPE" != "psql" ]; then
    HAS_MINIO=true
fi

if [ "$HAS_PSQL" = false ] && [ "$HAS_MINIO" = false ]; then
    echo -e "${YELLOW}${BOLD}⚠️  Warning:${NC} No backup directories found in ${CYAN}$BACKUP_ROOT${NC} 📭"
    exit 0
fi

echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"
echo -e "🧹 ${BOLD}Starting RAID Cleanup Process${NC} 🗑️\n"
echo -e "🏷️  ${BOLD}Environment:${NC} ${YELLOW}${ENVIRONMENT}${NC}"
echo -e "💿 ${BOLD}RAID Path  :${NC} ${YELLOW}${RAID_PATH}${NC}"
if [ "$HAS_PSQL" = true ]; then
    echo -e "🐘 ${BOLD}PostgreSQL :${NC} ${YELLOW}${PSQL_TARGET_DIR}${NC}"
fi
if [ "$HAS_MINIO" = true ]; then
    echo -e "📦 ${BOLD}MinIO      :${NC} ${YELLOW}${MINIO_TARGET_DIR}${NC}"
fi
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"

# Calculate 2 days ago in seconds (works on all platforms including BusyBox)
CURRENT_TIME=$(date +%s)
CUTOFF_TIME=$((CURRENT_TIME - 2 * 24 * 60 * 60))

PSQL_KEPT=0
PSQL_DELETED=0
MINIO_KEPT=0
MINIO_DELETED=0
TOTAL_SIZE_FREED=0

# Extract backup type from PostgreSQL backup name (e.g., "ffm_20260124_143851" -> "ffm")
extract_psql_type() {
    local name="$1"
    # Remove date pattern _YYYYMMDD_HHMMSS from end
    echo "$name" | sed -E 's/_[0-9]{8}_[0-9]{6}$//'
}

# Extract backup type from MinIO backup name (e.g., "store-logos_2026_0124_150253.tar.gz" -> "store-logos")
extract_minio_type() {
    local name="$1"
    # Remove date pattern _YYYY_MMDD_HHMMSS.tar.gz from end
    echo "$name" | sed -E 's/_[0-9]{4}_[0-9]{4}_[0-9]{6}\.tar\.gz$//'
}

# Cleanup backups for a specific type within a directory
# Args: backup_type, backup_files (newline-separated list of full paths)
cleanup_type_backups() {
    local backup_type="$1"
    local backups_list="$2"
    local kept_var="$3"
    local deleted_var="$4"

    local local_kept=0
    local local_deleted=0

    # Sort backups by modification time (newest first)
    local sorted_backups
    sorted_backups=$(echo "$backups_list" | while read -r backup; do
        if [ -n "$backup" ]; then
            local mtime
            mtime=$(stat -c%Y "$backup" 2>/dev/null || stat -f%m "$backup" 2>/dev/null || echo 0)
            echo "$mtime|$backup"
        fi
    done | sort -t'|' -k1 -rn | cut -d'|' -f2)

    local count=0
    local total_count
    total_count=$(echo "$sorted_backups" | grep -c . || echo 0)

    echo -e "   📁 ${BOLD}${backup_type}${NC}: ${YELLOW}${total_count}${NC} backup(s)"

    echo "$sorted_backups" | while read -r backup; do
        if [ -z "$backup" ]; then
            continue
        fi

        count=$((count + 1))
        local backup_name
        backup_name=$(basename "$backup")
        local backup_mtime
        backup_mtime=$(stat -c%Y "$backup" 2>/dev/null || stat -f%m "$backup" 2>/dev/null || echo 0)

        # Always keep the latest backup (first one after sorting)
        if [ "$count" -eq 1 ]; then
            echo -e "      🛡️  ${GREEN}Keeping${NC} ${CYAN}${backup_name}${NC} (latest)"
            local_kept=$((local_kept + 1))
            continue
        fi

        # Delete if older than 2 days
        if [ "$backup_mtime" -lt "$CUTOFF_TIME" ]; then
            local backup_size
            if [ -d "$backup" ]; then
                backup_size=$(du -sk "$backup" 2>/dev/null | cut -f1 || echo 0)
            else
                backup_size=$(stat -c%s "$backup" 2>/dev/null || stat -f%z "$backup" 2>/dev/null || echo 0)
                backup_size=$((backup_size / 1024))
            fi

            echo -e "      🗑️  ${YELLOW}Deleting${NC} ${CYAN}${backup_name}${NC} (older than 2 days)"

            if rm -rf "$backup" 2>/dev/null; then
                local_deleted=$((local_deleted + 1))
                # Update global counter (subshell workaround using temp file)
                echo "$backup_size" >> /tmp/cleanup_size_freed_$$
            else
                echo -e "         ${RED}✗${NC} Failed to delete"
            fi
        else
            echo -e "      🛡️  ${GREEN}Keeping${NC} ${CYAN}${backup_name}${NC} (less than 2 days old)"
            local_kept=$((local_kept + 1))
        fi
    done

    # Return counts via temp files (subshell workaround)
    echo "$local_kept" >> /tmp/cleanup_kept_${kept_var}_$$
    echo "$local_deleted" >> /tmp/cleanup_deleted_${deleted_var}_$$
}

# Cleanup all backups in a directory, auto-detecting types
cleanup_directory() {
    local target_dir="$1"
    local backup_kind="$2"  # "psql" or "minio"
    local icon="$3"
    local kept_var="$4"
    local deleted_var="$5"

    # Clean temp files
    rm -f /tmp/cleanup_kept_${kept_var}_$$ /tmp/cleanup_deleted_${deleted_var}_$$ /tmp/cleanup_size_freed_$$

    echo -e "\n${icon} ${BOLD}${backup_kind} Backups:${NC}"

    # Collect all backups and group by type
    declare -A type_backups

    if [ "$backup_kind" = "PostgreSQL" ]; then
        # PostgreSQL: directories matching pattern {name}_{YYYYMMDD}_{HHMMSS}
        while IFS= read -r -d '' backup; do
            local name
            name=$(basename "$backup")
            local btype
            btype=$(extract_psql_type "$name")
            if [ -n "$btype" ]; then
                if [ -z "${type_backups[$btype]}" ]; then
                    type_backups[$btype]="$backup"
                else
                    type_backups[$btype]="${type_backups[$btype]}"$'\n'"$backup"
                fi
            fi
        done < <(find "$target_dir" -maxdepth 1 -type d -regex '.*/[^/]*_[0-9]\{8\}_[0-9]\{6\}$' -print0 2>/dev/null)
    else
        # MinIO: files matching pattern {name}_{YYYY}_{MMDD}_{HHMMSS}.tar.gz
        while IFS= read -r -d '' backup; do
            local name
            name=$(basename "$backup")
            local btype
            btype=$(extract_minio_type "$name")
            if [ -n "$btype" ]; then
                if [ -z "${type_backups[$btype]}" ]; then
                    type_backups[$btype]="$backup"
                else
                    type_backups[$btype]="${type_backups[$btype]}"$'\n'"$backup"
                fi
            fi
        done < <(find "$target_dir" -maxdepth 1 -type f -name '*_*_*_*.tar.gz' -print0 2>/dev/null)
    fi

    local type_count=${#type_backups[@]}

    if [ "$type_count" -eq 0 ]; then
        echo -e "   ${YELLOW}⚠️  No backups found${NC} 📭"
        return
    fi

    echo -e "   Found ${YELLOW}${type_count}${NC} backup type(s)\n"

    # Process each type
    for btype in "${!type_backups[@]}"; do
        cleanup_type_backups "$btype" "${type_backups[$btype]}" "$kept_var" "$deleted_var"
    done

    # Sum up counts from temp files
    local total_kept=0
    local total_deleted=0

    if [ -f /tmp/cleanup_kept_${kept_var}_$$ ]; then
        while read -r count; do
            total_kept=$((total_kept + count))
        done < /tmp/cleanup_kept_${kept_var}_$$
        rm -f /tmp/cleanup_kept_${kept_var}_$$
    fi

    if [ -f /tmp/cleanup_deleted_${deleted_var}_$$ ]; then
        while read -r count; do
            total_deleted=$((total_deleted + count))
        done < /tmp/cleanup_deleted_${deleted_var}_$$
        rm -f /tmp/cleanup_deleted_${deleted_var}_$$
    fi

    if [ -f /tmp/cleanup_size_freed_$$ ]; then
        while read -r size; do
            TOTAL_SIZE_FREED=$((TOTAL_SIZE_FREED + size))
        done < /tmp/cleanup_size_freed_$$
        rm -f /tmp/cleanup_size_freed_$$
    fi

    eval "$kept_var=$total_kept"
    eval "$deleted_var=$total_deleted"
}

echo -e "\n🔍 ${BOLD}Analyzing backups...${NC}"

if [ "$HAS_PSQL" = true ]; then
    cleanup_directory "$PSQL_TARGET_DIR" "PostgreSQL" "🐘" "PSQL_KEPT" "PSQL_DELETED"
fi

if [ "$HAS_MINIO" = true ]; then
    cleanup_directory "$MINIO_TARGET_DIR" "MinIO" "📦" "MINIO_KEPT" "MINIO_DELETED"
fi

KEPT=$((PSQL_KEPT + MINIO_KEPT))
DELETED=$((PSQL_DELETED + MINIO_DELETED))

if [ "$TOTAL_SIZE_FREED" -gt 1048576 ]; then
    GB_SIZE=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE_FREED / 1048576}")
    SIZE_FORMATTED="${GB_SIZE} GB"
elif [ "$TOTAL_SIZE_FREED" -gt 1024 ]; then
    MB_SIZE=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE_FREED / 1024}")
    SIZE_FORMATTED="${MB_SIZE} MB"
else
    SIZE_FORMATTED="${TOTAL_SIZE_FREED} KB"
fi

echo -e "\n${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"
if [ "$DELETED" -gt 0 ]; then
    echo -e "${GREEN}${BOLD}✅✓ Cleanup completed successfully! 🎉${NC}"
    echo -e "🛡️  ${BOLD}Backups Kept   :${NC} ${YELLOW}${KEPT}${NC}"
    if [ "$PSQL_KEPT" -gt 0 ]; then
        echo -e "   🐘 ${BOLD}PostgreSQL :${NC} ${YELLOW}${PSQL_KEPT}${NC}"
    fi
    if [ "$MINIO_KEPT" -gt 0 ]; then
        echo -e "   📦 ${BOLD}MinIO      :${NC} ${YELLOW}${MINIO_KEPT}${NC}"
    fi
    echo -e "🗑️  ${BOLD}Backups Deleted:${NC} ${YELLOW}${DELETED}${NC}"
    if [ "$PSQL_DELETED" -gt 0 ]; then
        echo -e "   🐘 ${BOLD}PostgreSQL :${NC} ${YELLOW}${PSQL_DELETED}${NC}"
    fi
    if [ "$MINIO_DELETED" -gt 0 ]; then
        echo -e "   📦 ${BOLD}MinIO      :${NC} ${YELLOW}${MINIO_DELETED}${NC}"
    fi
    echo -e "💾 ${BOLD}Space Freed    :${NC} ${YELLOW}${SIZE_FORMATTED}${NC}"
else
    echo -e "${GREEN}${BOLD}✅✓ Cleanup completed${NC}"
    echo -e "🛡️  ${BOLD}Backups Kept   :${NC} ${YELLOW}${KEPT}${NC}"
    if [ "$PSQL_KEPT" -gt 0 ]; then
        echo -e "   🐘 ${BOLD}PostgreSQL :${NC} ${YELLOW}${PSQL_KEPT}${NC}"
    fi
    if [ "$MINIO_KEPT" -gt 0 ]; then
        echo -e "   📦 ${BOLD}MinIO      :${NC} ${YELLOW}${MINIO_KEPT}${NC}"
    fi
    echo -e "ℹ️  ${BOLD}No backups deleted (all are recent or protected)${NC}"
fi

LOCAL_DUMPS_DIR="$PROJECT_ROOT/dumps/$ENVIRONMENT"
if [ "$BACKUP_TYPE" = "psql" ]; then
    LOCAL_CLEANUP_DIR="$LOCAL_DUMPS_DIR/psql"
elif [ "$BACKUP_TYPE" = "minio" ]; then
    LOCAL_CLEANUP_DIR="$LOCAL_DUMPS_DIR/minio"
else
    LOCAL_CLEANUP_DIR="$LOCAL_DUMPS_DIR"
fi
if [ -d "$LOCAL_CLEANUP_DIR" ]; then
    echo -e "\n🧹 ${BOLD}Cleaning local dumps directory...${NC}"
    if rm -rf "$LOCAL_CLEANUP_DIR" 2>/dev/null; then
        echo -e "   ${GREEN}✓${NC} Removed ${CYAN}$LOCAL_CLEANUP_DIR${NC}"
    else
        echo -e "   ${YELLOW}⚠️${NC} Failed to remove ${CYAN}$LOCAL_CLEANUP_DIR${NC}"
    fi
fi

echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}\n"
