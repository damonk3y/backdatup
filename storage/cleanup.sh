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

if [ ! -f "$PROJECT_ROOT/.env" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} .env file not found in ${CYAN}$PROJECT_ROOT${NC} 😱"
    exit 1
fi

source "$PROJECT_ROOT/.env"

if [ -z "${RAID_PATH}" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} RAID_PATH environment variable is not set ⚠️"
    exit 1
fi

if [ -z "${POSTGRES_DB}" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} POSTGRES_DB environment variable is not set ⚠️"
    exit 1
fi

TARGET_DIR="${RAID_PATH}/backthatup/psql"

if [ ! -d "$RAID_PATH" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} RAID mount path not found: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

if [ ! -w "$RAID_PATH" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} RAID mount path is not writable: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

if [ ! -d "$TARGET_DIR" ]; then
    echo -e "${YELLOW}${BOLD}⚠️  Warning:${NC} Target directory not found: ${CYAN}$TARGET_DIR${NC} 📭"
    exit 0
fi

echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"
echo -e "🧹 ${BOLD}Starting RAID Cleanup Process${NC} 🗑️\n"
echo -e "💿 ${BOLD}RAID Path  :${NC} ${YELLOW}${RAID_PATH}${NC}"
echo -e "📂 ${BOLD}Target Dir :${NC} ${YELLOW}${TARGET_DIR}${NC}"
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"

BACKUP_DIRS=()
while IFS= read -r -d '' backup; do
    BACKUP_DIRS+=("$backup")
done < <(find "$TARGET_DIR" -maxdepth 1 -type d -name "${POSTGRES_DB}_*" -print0 2>/dev/null | sort -rz)

while IFS= read -r -d '' backup; do
    BACKUP_DIRS+=("$backup")
done < <(find "$TARGET_DIR" -maxdepth 1 -type f \( -name "${POSTGRES_DB}_*.dump" -o -name "${POSTGRES_DB}.dump" \) -print0 2>/dev/null | sort -rz)

BACKUP_COUNT=${#BACKUP_DIRS[@]}

if [ "$BACKUP_COUNT" -eq 0 ]; then
    echo -e "\n${YELLOW}${BOLD}⚠️  Warning:${NC} No backups found in ${CYAN}$TARGET_DIR${NC} 📭"
    exit 0
fi

echo -e "\n📊 ${BOLD}Found ${YELLOW}${BACKUP_COUNT}${NC} ${BOLD}backup(s)${NC}\n"

if [ "$BACKUP_COUNT" -lt 3 ]; then
    echo -e "${YELLOW}${BOLD}⚠️  Skipping cleanup:${NC} Only ${YELLOW}${BACKUP_COUNT}${NC} backup(s) found. Need at least 3 to proceed. 🛡️"
    exit 0
fi

CUTOFF_TIME=$(date -v-2d +%s 2>/dev/null || date -d "2 days ago" +%s)
KEPT=0
DELETED=0
TOTAL_SIZE_FREED=0

echo -e "🔍 ${BOLD}Analyzing backups...${NC}\n"

for i in "${!BACKUP_DIRS[@]}"; do
    backup="${BACKUP_DIRS[$i]}"
    backup_name=$(basename "$backup")

    if [ -d "$backup" ]; then
        backup_mtime=$(stat -f%m "$backup" 2>/dev/null || stat -c%Y "$backup" 2>/dev/null || echo 0)
    else
        backup_mtime=$(stat -f%m "$backup" 2>/dev/null || stat -c%Y "$backup" 2>/dev/null || echo 0)
    fi

    if [ "$i" -lt 3 ]; then
        KEPT=$((KEPT + 1))
        backup_date=$(date -r "$backup_mtime" +"%Y-%m-%d %H:%M:%S" 2>/dev/null || date -d "@$backup_mtime" +"%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "unknown")
        echo -e "🛡️  ${GREEN}Keeping${NC} ${CYAN}${backup_name}${NC} (latest ${KEPT}/3, modified: ${YELLOW}${backup_date}${NC})"
        continue
    fi

    if [ "$backup_mtime" -lt "$CUTOFF_TIME" ]; then
        if [ -d "$backup" ]; then
            backup_size=$(du -sk "$backup" 2>/dev/null | cut -f1 || echo 0)
        else
            backup_size=$(stat -f%z "$backup" 2>/dev/null || stat -c%s "$backup" 2>/dev/null || echo 0)
            backup_size=$((backup_size / 1024))
        fi

        backup_date=$(date -r "$backup_mtime" +"%Y-%m-%d %H:%M:%S" 2>/dev/null || date -d "@$backup_mtime" +"%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "unknown")

        echo -e "🗑️  ${YELLOW}Deleting${NC} ${CYAN}${backup_name}${NC} (older than 2 days, modified: ${YELLOW}${backup_date}${NC})"

        if rm -rf "$backup" 2>/dev/null; then
            DELETED=$((DELETED + 1))
            TOTAL_SIZE_FREED=$((TOTAL_SIZE_FREED + backup_size))
        else
            echo -e "   ${RED}✗${NC} Failed to delete"
        fi
    else
        KEPT=$((KEPT + 1))
        backup_date=$(date -r "$backup_mtime" +"%Y-%m-%d %H:%M:%S" 2>/dev/null || date -d "@$backup_mtime" +"%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "unknown")
        echo -e "🛡️  ${GREEN}Keeping${NC} ${CYAN}${backup_name}${NC} (less than 2 days old, modified: ${YELLOW}${backup_date}${NC})"
    fi
done

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
    echo -e "🛡️  ${BOLD}Backups Kept :${NC} ${YELLOW}${KEPT}${NC}"
    echo -e "🗑️  ${BOLD}Backups Deleted:${NC} ${YELLOW}${DELETED}${NC}"
    echo -e "💾 ${BOLD}Space Freed  :${NC} ${YELLOW}${SIZE_FORMATTED}${NC}"
else
    echo -e "${GREEN}${BOLD}✅✓ Cleanup completed${NC}"
    echo -e "🛡️  ${BOLD}Backups Kept :${NC} ${YELLOW}${KEPT}${NC}"
    echo -e "ℹ️  ${BOLD}No backups deleted (all are recent or protected)${NC}"
fi

LOCAL_DUMPS_DIR="$PROJECT_ROOT/dumps"
if [ -d "$LOCAL_DUMPS_DIR" ]; then
    echo -e "\n🧹 ${BOLD}Cleaning local dumps directory...${NC}"
    if rm -rf "$LOCAL_DUMPS_DIR" 2>/dev/null; then
        echo -e "   ${GREEN}✓${NC} Removed ${CYAN}$LOCAL_DUMPS_DIR${NC}"
    else
        echo -e "   ${YELLOW}⚠️${NC} Failed to remove ${CYAN}$LOCAL_DUMPS_DIR${NC}"
    fi
fi

echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}\n"
