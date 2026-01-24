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

if [ -z "${POSTGRES_DB}" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} POSTGRES_DB environment variable is not set ⚠️"
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

if [ -d "$PSQL_TARGET_DIR" ]; then
    HAS_PSQL=true
fi

if [ -d "$MINIO_TARGET_DIR" ]; then
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

cleanup_backups() {
    local target_dir="$1"
    local pattern="$2"
    local backup_type="$3"
    local icon="$4"
    local kept_var="$5"
    local deleted_var="$6"

    local backups=()

    while IFS= read -r -d '' backup; do
        backups+=("$backup")
    done < <(find "$target_dir" -maxdepth 1 -type d -name "${pattern}_*" -print0 2>/dev/null | sort -rz)

    while IFS= read -r -d '' backup; do
        backups+=("$backup")
    done < <(find "$target_dir" -maxdepth 1 -type f \( -name "${pattern}_*.dump" -o -name "${pattern}.dump" -o -name "${pattern}_*.tar.gz" -o -name "*_*.tar.gz" \) -print0 2>/dev/null | sort -rz)

    local backup_count=${#backups[@]}

    if [ "$backup_count" -eq 0 ]; then
        echo -e "\n${YELLOW}${BOLD}⚠️  Warning:${NC} No ${backup_type} backups found 📭"
        return
    fi

    echo -e "\n${icon} ${BOLD}${backup_type} Backups:${NC} Found ${YELLOW}${backup_count}${NC} backup(s)"

    if [ "$backup_count" -lt 3 ]; then
        echo -e "   ${YELLOW}⚠️  Skipping:${NC} Only ${backup_count} backup(s). Need at least 3 to cleanup. 🛡️"
        eval "$kept_var=\$backup_count"
        return
    fi

    echo ""

    local local_kept=0
    local local_deleted=0

    for i in "${!backups[@]}"; do
        local backup="${backups[$i]}"
        local backup_name=$(basename "$backup")
        local backup_mtime=$(stat -f%m "$backup" 2>/dev/null || stat -c%Y "$backup" 2>/dev/null || echo 0)

        if [ "$i" -lt 3 ]; then
            local_kept=$((local_kept + 1))
            local backup_date=$(date -r "$backup_mtime" +"%Y-%m-%d %H:%M:%S" 2>/dev/null || date -d "@$backup_mtime" +"%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "unknown")
            echo -e "   🛡️  ${GREEN}Keeping${NC} ${CYAN}${backup_name}${NC} (latest ${local_kept}/3)"
            continue
        fi

        if [ "$backup_mtime" -lt "$CUTOFF_TIME" ]; then
            local backup_size
            if [ -d "$backup" ]; then
                backup_size=$(du -sk "$backup" 2>/dev/null | cut -f1 || echo 0)
            else
                backup_size=$(stat -f%z "$backup" 2>/dev/null || stat -c%s "$backup" 2>/dev/null || echo 0)
                backup_size=$((backup_size / 1024))
            fi

            echo -e "   🗑️  ${YELLOW}Deleting${NC} ${CYAN}${backup_name}${NC} (older than 2 days)"

            if rm -rf "$backup" 2>/dev/null; then
                local_deleted=$((local_deleted + 1))
                TOTAL_SIZE_FREED=$((TOTAL_SIZE_FREED + backup_size))
            else
                echo -e "      ${RED}✗${NC} Failed to delete"
            fi
        else
            local_kept=$((local_kept + 1))
            echo -e "   🛡️  ${GREEN}Keeping${NC} ${CYAN}${backup_name}${NC} (less than 2 days old)"
        fi
    done

    eval "$kept_var=$local_kept"
    eval "$deleted_var=$local_deleted"
}

echo -e "\n🔍 ${BOLD}Analyzing backups...${NC}"

if [ "$HAS_PSQL" = true ]; then
    cleanup_backups "$PSQL_TARGET_DIR" "$POSTGRES_DB" "PostgreSQL" "🐘" "PSQL_KEPT" "PSQL_DELETED"
fi

if [ "$HAS_MINIO" = true ]; then
    cleanup_backups "$MINIO_TARGET_DIR" "*" "MinIO" "📦" "MINIO_KEPT" "MINIO_DELETED"
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
    SIZE_FORMATTED="${TOTAL_SIZE_FREED} MB"
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
if [ -d "$LOCAL_DUMPS_DIR" ]; then
    echo -e "\n🧹 ${BOLD}Cleaning local dumps directory...${NC}"
    if rm -rf "$LOCAL_DUMPS_DIR" 2>/dev/null; then
        echo -e "   ${GREEN}✓${NC} Removed ${CYAN}$LOCAL_DUMPS_DIR${NC}"
    else
        echo -e "   ${YELLOW}⚠️${NC} Failed to remove ${CYAN}$LOCAL_DUMPS_DIR${NC}"
    fi
fi

echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}\n"
