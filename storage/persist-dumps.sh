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

# BACKUP_TYPE scopes which files to persist: psql, minio, or full (default)
BACKUP_TYPE="${BACKUP_TYPE:-full}"

DUMP_BASE="$PROJECT_ROOT/dumps/$ENVIRONMENT"
RAID_BASE="${RAID_PATH}/backthatup/$ENVIRONMENT"

# Scope psql source to specific database for job isolation
if [ -n "$POSTGRES_DB" ]; then
    PSQL_DUMP_DIR="$DUMP_BASE/psql/$POSTGRES_DB"
else
    PSQL_DUMP_DIR="$DUMP_BASE/psql"
fi
MINIO_DUMP_DIR="$DUMP_BASE/minio"
PSQL_TARGET_DIR="$RAID_BASE/psql"
MINIO_TARGET_DIR="$RAID_BASE/minio"

if [ ! -d "$RAID_PATH" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} RAID mount path not found: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

if [ ! -w "$RAID_PATH" ]; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} RAID mount path is not writable: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

PROBE_FILE="$RAID_PATH/.write_probe_$$"
if ! touch "$PROBE_FILE" 2>/dev/null || ! rm -f "$PROBE_FILE" 2>/dev/null; then
    echo -e "${RED}${BOLD}❌✗ Error:${NC} RAID mount path failed write probe: ${CYAN}$RAID_PATH${NC} (mount may be stale or read-only) 😱"
    exit 1
fi

# Determine which types to process
PROCESS_PSQL=false
PROCESS_MINIO=false

if [ "$BACKUP_TYPE" = "psql" ]; then
    PROCESS_PSQL=true
elif [ "$BACKUP_TYPE" = "minio" ]; then
    PROCESS_MINIO=true
else
    # full mode
    PROCESS_PSQL=true
    PROCESS_MINIO=true
fi

# Check source directories exist
HAS_PSQL_FILES=false
HAS_MINIO_FILES=false

if [ "$PROCESS_PSQL" = true ] && [ -d "$PSQL_DUMP_DIR" ]; then
    PSQL_FILE_COUNT=$(find "$PSQL_DUMP_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
    if [ "$PSQL_FILE_COUNT" -gt 0 ]; then
        HAS_PSQL_FILES=true
    fi
fi

if [ "$PROCESS_MINIO" = true ] && [ -d "$MINIO_DUMP_DIR" ]; then
    MINIO_FILE_COUNT=$(find "$MINIO_DUMP_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
    if [ "$MINIO_FILE_COUNT" -gt 0 ]; then
        HAS_MINIO_FILES=true
    fi
fi

if [ "$HAS_PSQL_FILES" = false ] && [ "$HAS_MINIO_FILES" = false ]; then
    echo -e "\n${YELLOW}${BOLD}⚠️  Warning:${NC} No files found to persist 📭"
    exit 0
fi

echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"
echo -e "💾 ${BOLD}Starting Dump Persistence to RAID${NC} 🗄️\n"
echo -e "🏷️  ${BOLD}Environment:${NC} ${YELLOW}$ENVIRONMENT${NC}"
if [ "$HAS_PSQL_FILES" = true ]; then
    echo -e "🐘 ${BOLD}PostgreSQL :${NC} ${YELLOW}$PSQL_DUMP_DIR${NC} → ${YELLOW}$PSQL_TARGET_DIR${NC}"
    echo -e "   ${BOLD}Files      :${NC} ${YELLOW}${PSQL_FILE_COUNT}${NC}"
fi
if [ "$HAS_MINIO_FILES" = true ]; then
    echo -e "📦 ${BOLD}MinIO      :${NC} ${YELLOW}$MINIO_DUMP_DIR${NC} → ${YELLOW}$MINIO_TARGET_DIR${NC}"
    echo -e "   ${BOLD}Files      :${NC} ${YELLOW}${MINIO_FILE_COUNT}${NC}"
fi
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"

COPIED=0
SKIPPED=0
FAILED=0
TOTAL_SIZE_COPIED=0
MINIO_COPIED=0
PSQL_COPIED=0

# Persist files from a source directory to a target directory
# Args: $1=source_dir $2=target_dir $3=type_label ("psql" or "minio")
persist_files() {
    local source_dir="$1"
    local target_dir="$2"
    local type_label="$3"

    mkdir -p "$target_dir"

    while IFS= read -r -d '' source_file; do
        local relative_path="${source_file#$source_dir/}"
        local target_file="$target_dir/$relative_path"
        local target_file_dir
        target_file_dir=$(dirname "$target_file")

        if [ -f "$target_file" ]; then
            local source_size
            source_size=$(stat -f%z "$source_file" 2>/dev/null || stat -c%s "$source_file" 2>/dev/null || echo 0)
            local target_size
            target_size=$(stat -f%z "$target_file" 2>/dev/null || stat -c%s "$target_file" 2>/dev/null || echo 0)
            if [ "$source_size" -eq "$target_size" ]; then
                SKIPPED=$((SKIPPED + 1))
                continue
            fi
        fi

        mkdir -p "$target_file_dir"

        if cp_err=$(cp "$source_file" "$target_file" 2>&1); then
            COPIED=$((COPIED + 1))
            local file_size
            file_size=$(stat -f%z "$target_file" 2>/dev/null || stat -c%s "$target_file" 2>/dev/null || echo 0)
            TOTAL_SIZE_COPIED=$((TOTAL_SIZE_COPIED + file_size))

            if [ "$type_label" = "minio" ]; then
                MINIO_COPIED=$((MINIO_COPIED + 1))
                local icon="📦"
            else
                PSQL_COPIED=$((PSQL_COPIED + 1))
                local icon="🐘"
            fi

            if [ "$COPIED" -eq 1 ] || [ $((COPIED % 10)) -eq 0 ]; then
                echo -e "${icon} ${BOLD}Copied${NC} ${CYAN}${relative_path}${NC}"
            fi
        else
            FAILED=$((FAILED + 1))
            echo -e "   ${RED}✗${NC} Failed to copy ${CYAN}${relative_path}${NC}: ${cp_err}"
        fi
    done < <(find "$source_dir" -type f -print0 2>/dev/null)
}

echo -e "\n🔍 ${BOLD}Persisting files...${NC}\n"

if [ "$HAS_PSQL_FILES" = true ]; then
    persist_files "$PSQL_DUMP_DIR" "$PSQL_TARGET_DIR" "psql"
fi

if [ "$HAS_MINIO_FILES" = true ]; then
    persist_files "$MINIO_DUMP_DIR" "$MINIO_TARGET_DIR" "minio"
fi

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
