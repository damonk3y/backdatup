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

DUMP_DIR="$PROJECT_ROOT/dumps"
MINIO_DUMP_DIR="$DUMP_DIR/minio"
PSQL_DUMP_DIR="$DUMP_DIR/psql"
TARGET_DIR="${RAID_PATH}/backthatup"

if [ ! -d "$DUMP_DIR" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} Dumps directory not found: ${CYAN}$DUMP_DIR${NC} 😱"
    exit 1
fi

if [ ! -d "$RAID_PATH" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} RAID mount path not found: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

if [ ! -w "$RAID_PATH" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} RAID mount path is not writable: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

mkdir -p "$TARGET_DIR"

echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"
echo -e "💾 ${BOLD}Starting Dump Persistence to RAID${NC} 🗄️\n"
echo -e "📂 ${BOLD}Source    :${NC} ${YELLOW}$DUMP_DIR${NC}"
echo -e "🎯 ${BOLD}Target    :${NC} ${YELLOW}$TARGET_DIR${NC}"
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"

TOTAL_FILES=$(find "$DUMP_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
MINIO_FILES=$(find "$MINIO_DUMP_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
PSQL_FILES=$(find "$PSQL_DUMP_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')

if [ "$TOTAL_FILES" -eq 0 ]; then
    echo -e "\n${YELLOW}${BOLD}⚠️  Warning:${NC} No files found in ${CYAN}$DUMP_DIR${NC} 📭"
    exit 0
fi

echo -e "\n🔍 ${BOLD}Scanning for new files to persist...${NC}"
if [ "$PSQL_FILES" -gt 0 ]; then
    echo -e "   🐘 PostgreSQL dumps: ${YELLOW}${PSQL_FILES}${NC} files"
fi
if [ "$MINIO_FILES" -gt 0 ]; then
    echo -e "   📦 MinIO backups: ${YELLOW}${MINIO_FILES}${NC} files"
fi
echo ""

COPIED=0
SKIPPED=0
FAILED=0
TOTAL_SIZE_COPIED=0
MINIO_COPIED=0
PSQL_COPIED=0

while IFS= read -r -d '' source_file; do
    relative_path="${source_file#$DUMP_DIR/}"
    target_file="$TARGET_DIR/$relative_path"
    target_dir=$(dirname "$target_file")
    if [ -f "$target_file" ]; then
        source_size=$(stat -f%z "$source_file" 2>/dev/null || stat -c%s "$source_file" 2>/dev/null || echo 0)
        target_size=$(stat -f%z "$target_file" 2>/dev/null || stat -c%s "$target_file" 2>/dev/null || echo 0)
        if [ "$source_size" -eq "$target_size" ]; then
            SKIPPED=$((SKIPPED + 1))
            continue
        fi
    fi
    mkdir -p "$target_dir"
    if cp "$source_file" "$target_file" 2>/dev/null; then
        COPIED=$((COPIED + 1))
        file_size=$(stat -f%z "$target_file" 2>/dev/null || stat -c%s "$target_file" 2>/dev/null || echo 0)
        TOTAL_SIZE_COPIED=$((TOTAL_SIZE_COPIED + file_size))
        if [[ "$relative_path" == minio/* ]]; then
            MINIO_COPIED=$((MINIO_COPIED + 1))
            icon="📦"
        elif [[ "$relative_path" == psql/* ]]; then
            PSQL_COPIED=$((PSQL_COPIED + 1))
            icon="🐘"
        else
            icon="📋"
        fi
        if [ "$COPIED" -eq 1 ] || [ $((COPIED % 10)) -eq 0 ]; then
            echo -e "${icon} ${BOLD}Copied${NC} ${CYAN}${relative_path}${NC}"
        fi
    else
        FAILED=$((FAILED + 1))
        echo -e "   ${RED}✗${NC} Failed to copy ${CYAN}${relative_path}${NC}"
    fi
done < <(find "$DUMP_DIR" -type f -print0 2>/dev/null)

if [ "$TOTAL_SIZE_COPIED" -gt 1073741824 ]; then
    GB_SIZE=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE_COPIED / 1073741824}")
    SIZE_FORMATTED="${GB_SIZE} GB"
elif [ "$TOTAL_SIZE_COPIED" -gt 1048576 ]; then
    MB_SIZE=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE_COPIED / 1048576}")
    SIZE_FORMATTED="${MB_SIZE} MB"
elif [ "$TOTAL_SIZE_COPIED" -gt 1024 ]; then
    KB_SIZE=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE_COPIED / 1024}")
    SIZE_FORMATTED="${KB_SIZE} KB"
else
    SIZE_FORMATTED="${TOTAL_SIZE_COPIED} bytes"
fi

echo -e "\n${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"
if [ "$FAILED" -eq 0 ]; then
    TOTAL_SIZE=$(du -sh "$TARGET_DIR" | cut -f1)
    echo -e "${GREEN}${BOLD}✅✓ Persistence completed successfully! 🎉${NC}"
    echo -e "📊 ${BOLD}Files Copied :${NC} ${YELLOW}${COPIED}${NC}"
    if [ "$PSQL_COPIED" -gt 0 ]; then
        echo -e "   🐘 ${BOLD}PostgreSQL:${NC} ${YELLOW}${PSQL_COPIED}${NC}"
    fi
    if [ "$MINIO_COPIED" -gt 0 ]; then
        echo -e "   📦 ${BOLD}MinIO     :${NC} ${YELLOW}${MINIO_COPIED}${NC}"
    fi
    if [ "$SKIPPED" -gt 0 ]; then
        echo -e "⏭️  ${BOLD}Files Skipped:${NC} ${YELLOW}${SKIPPED}${NC} (already exist)"
    fi
    if [ "$COPIED" -gt 0 ]; then
        echo -e "📏 ${BOLD}Size Copied  :${NC} ${YELLOW}${SIZE_FORMATTED}${NC}"
    fi
    echo -e "💾 ${BOLD}Total in RAID:${NC} ${YELLOW}${TOTAL_SIZE}${NC}"
    echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}\n"
else
    echo -e "${YELLOW}${BOLD}⚠️  Persistence completed with warnings${NC}"
    echo -e "📊 ${BOLD}Files Copied :${NC} ${YELLOW}${COPIED}${NC}"
    if [ "$PSQL_COPIED" -gt 0 ]; then
        echo -e "   🐘 ${BOLD}PostgreSQL:${NC} ${YELLOW}${PSQL_COPIED}${NC}"
    fi
    if [ "$MINIO_COPIED" -gt 0 ]; then
        echo -e "   📦 ${BOLD}MinIO     :${NC} ${YELLOW}${MINIO_COPIED}${NC}"
    fi
    if [ "$SKIPPED" -gt 0 ]; then
        echo -e "⏭️  ${BOLD}Files Skipped:${NC} ${YELLOW}${SKIPPED}${NC}"
    fi
    echo -e "❌ ${BOLD}Files Failed :${NC} ${RED}${FAILED}${NC}"
    echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}\n"
    exit 1
fi
