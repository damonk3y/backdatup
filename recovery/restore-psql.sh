#!/bin/bash
#
# PostgreSQL Restore Script
#
# Usage (latest backup from RAID):
#   make restore-psql
#
# Usage (specific/downloaded backup):
#   See RESTORE.md for full instructions.
#   Typical flow after downloading from the Web UI:
#     tar -xzf mydb_20260614_....tar.gz
#     pg_restore -h ... -d targetdb --clean --if-exists -j 4 ./mydb_20260614_.../
#
# You can also override variables:
#   POSTGRES_DB=otherdb BACKDATUP_ENV_FILE=.env.test make restore-psql
#
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}${BOLD}ℹ️  $*${NC}"; }
success() { echo -e "${GREEN}${BOLD}✅ $*${NC}"; }
warn()    { echo -e "${YELLOW}${BOLD}⚠️  $*${NC}"; }
error()   { echo -e "${RED}${BOLD}🛑 $*${NC}"; }

divider="${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Use BACKDATUP_ENV_FILE if set (from web UI), otherwise fall back to .env
ENV_FILE="${BACKDATUP_ENV_FILE:-$PROJECT_ROOT/.env}"

if [ ! -f "$ENV_FILE" ]; then
    error "Missing .env file at ${CYAN}$ENV_FILE${NC} 😱"
    exit 1
fi

source "$ENV_FILE"

required_vars=("POSTGRES_USER" "POSTGRES_PASSWORD" "POSTGRES_HOST" "POSTGRES_PORT" "POSTGRES_DB" "RAID_PATH" "ENVIRONMENT")
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        warn "Environment variable ${YELLOW}$var${NC} is not set. Can't continue 🫸⚠️"
        exit 1
    fi
done

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "prod" ]]; then
    error "ENVIRONMENT must be ${YELLOW}staging${NC} or ${YELLOW}prod${NC}"
    exit 1
fi

DUMP_DIR="${RAID_PATH}/backthatup/$ENVIRONMENT/psql/"

if [ ! -d "$RAID_PATH" ]; then
    error "RAID mount path not found: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

if [ ! -r "$RAID_PATH" ]; then
    error "RAID mount path is not readable: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

if [ ! -d "$DUMP_DIR" ]; then
    error "Dumps directory not found at ${CYAN}$DUMP_DIR${NC} 😱"
    exit 1
fi

LATEST_BACKUP=$(find "$DUMP_DIR" -maxdepth 1 -type d -name "${POSTGRES_DB}_*" 2>/dev/null | sort -r | head -n 1)
if [ -z "$LATEST_BACKUP" ]; then
    LATEST_BACKUP=$(find "$DUMP_DIR" -maxdepth 1 \( -type f -name "${POSTGRES_DB}_*.dump" -o -type f -name "${POSTGRES_DB}.dump" \) 2>/dev/null | sort -r | head -n 1)
fi

if [ -z "$LATEST_BACKUP" ]; then
    error "No backup found for database ${YELLOW}${POSTGRES_DB}${NC} in ${CYAN}$DUMP_DIR${NC} 😬"
    exit 1
fi

NUM_JOBS=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
if [ "$NUM_JOBS" -gt 4 ]; then
    NUM_JOBS=4
fi

echo -e "$divider"
echo -e "🐘🔄 ${BOLD}Starting PostgreSQL Restore Process${NC} 🚀"
info   "🏷️  Environment: ${YELLOW}${ENVIRONMENT}${NC}"
info   "💾 Database : ${YELLOW}${POSTGRES_DB}${NC}"
info   "🌐 Host     : ${YELLOW}${POSTGRES_HOST}${NC}:${YELLOW}${POSTGRES_PORT}${NC}"
info   "💿 Source   : ${YELLOW}${RAID_PATH}/backthatup/${ENVIRONMENT}${NC}"
info   "📄 Backup   : ${YELLOW}$LATEST_BACKUP${NC}"

if [ -d "$LATEST_BACKUP" ]; then
    BACKUP_SIZE=$(du -sh "$LATEST_BACKUP" | cut -f1)
    info   "📦 Format   : ${YELLOW}Directory${NC}"
    info   "⚡ Parallel : ${YELLOW}${NUM_JOBS} jobs${NC}"
else
    BACKUP_SIZE=$(du -h "$LATEST_BACKUP" | cut -f1)
    info   "📦 Format   : ${YELLOW}File${NC}"
fi
info   "📏 Size     : ${YELLOW}$BACKUP_SIZE${NC}"
echo -e "$divider"

export PGPASSWORD="${POSTGRES_PASSWORD}"

restore_success() {
    unset PGPASSWORD
    echo -e "\n${GREEN}${BOLD}🎉🛠️  Restore completed successfully! 🚀${NC}"
    echo -e "$divider\n"
}

restore_failure() {
    unset PGPASSWORD
    error "pg_restore failed 💥 Try checking connection or disk space!"
    exit 1
}

check_restore_errors() {
    local restore_output="$1"
    local exit_code="$2"
    if [ "$exit_code" -eq 0 ]; then
        return 0
    fi
    if echo "$restore_output" | grep -q "unrecognized configuration parameter" && echo "$restore_output" | grep -q "errors ignored on restore"; then
        IGNORED_COUNT=$(echo "$restore_output" | grep "errors ignored on restore:" | sed -E 's/.*errors ignored on restore: ([0-9]+).*/\1/' | head -1)
        if [ -n "$IGNORED_COUNT" ]; then
            warn "Some configuration parameters were not recognized (version compatibility)"
            warn "pg_restore ignored ${IGNORED_COUNT} error(s) - restore likely succeeded"
        fi
        FATAL_ERRORS=$(echo "$restore_output" | grep -iE "error:" | grep -v "unrecognized configuration parameter" | grep -v "errors ignored" | wc -l | tr -d ' ')
        if [ "$FATAL_ERRORS" -eq 0 ]; then
            return 0
        fi
    fi
    return 1
}

if [ -d "$LATEST_BACKUP" ]; then
    info "⏳ Restoring from directory with ${YELLOW}${NUM_JOBS}${NC} parallel jobs... 🍀"
    set +e
    RESTORE_OUTPUT=$(pg_restore -h "${POSTGRES_HOST}" \
        -p "${POSTGRES_PORT}" \
        -U "${POSTGRES_USER}" \
        -d "${POSTGRES_DB}" \
        -j "${NUM_JOBS}" \
        --no-owner \
        --no-acl \
        --clean \
        --if-exists \
        "$LATEST_BACKUP" 2>&1)
    RESTORE_EXIT=$?
    set -e
    echo "$RESTORE_OUTPUT"
    if check_restore_errors "$RESTORE_OUTPUT" "$RESTORE_EXIT"; then
        restore_success
    else
        restore_failure
    fi
else
    info "⏳ Restoring from dump file... 📂"
    set +e
    RESTORE_OUTPUT=$(pg_restore -h "${POSTGRES_HOST}" \
        -p "${POSTGRES_PORT}" \
        -U "${POSTGRES_USER}" \
        -d "${POSTGRES_DB}" \
        --no-owner \
        --no-acl \
        --clean \
        --if-exists \
        "$LATEST_BACKUP" 2>&1)
    RESTORE_EXIT=$?
    set -e
    echo "$RESTORE_OUTPUT"
    if check_restore_errors "$RESTORE_OUTPUT" "$RESTORE_EXIT"; then
        restore_success
    else
        restore_failure
    fi
fi
