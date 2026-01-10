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

required_vars=("POSTGRES_USER" "POSTGRES_PASSWORD" "POSTGRES_HOST" "POSTGRES_PORT" "POSTGRES_DB")
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo -e "${RED}${BOLD}❌✗ Error:${NC} Required environment variable ${YELLOW}$var${NC} is not set ⚠️"
        exit 1
    fi
done

DUMP_DIR="$PROJECT_ROOT/dumps/psql/"
mkdir -p "$DUMP_DIR"

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="$DUMP_DIR/${POSTGRES_DB}_${TIMESTAMP}"

NUM_JOBS=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
if [ "$NUM_JOBS" -gt 4 ]; then
    NUM_JOBS=4
fi

echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"
echo -e "🚀 ${BOLD}Starting PostgreSQL Backup${NC} 🐘\n"
echo -e "💾 ${BOLD}Database  :${NC} ${YELLOW}${POSTGRES_DB}${NC}"
echo -e "🌐 ${BOLD}Host      :${NC} ${YELLOW}${POSTGRES_HOST}${NC}:${YELLOW}${POSTGRES_PORT}${NC}"
echo -e "📄 ${BOLD}Dump Dir  :${NC} ${YELLOW}${BACKUP_DIR}${NC}"
echo -e "⚡ ${BOLD}Parallel  :${NC} ${YELLOW}${NUM_JOBS} jobs${NC}"
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}"

export PGPASSWORD="${POSTGRES_PASSWORD}"

if pg_dump -Fd \
    -h "${POSTGRES_HOST}" \
    -p "${POSTGRES_PORT}" \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    -j "${NUM_JOBS}" \
    -Z 1 \
    --no-owner \
    --no-acl \
    -f "$BACKUP_DIR"; then

    unset PGPASSWORD

    if [ -d "$BACKUP_DIR" ]; then
        BACKUP_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
        echo -e "\n${GREEN}${BOLD}✅✓ Backup completed successfully! 🎉${NC}"
        echo -e "📦 ${BOLD}Directory:${NC} ${CYAN}$BACKUP_DIR${NC}"
        echo -e "📏 ${BOLD}Size:${NC} ${YELLOW}$BACKUP_SIZE${NC}"
        echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════${NC}\n"
    else
        echo -e "\n${RED}${BOLD}❌✗ Error:${NC} Backup directory was not created 😬"
        exit 1
    fi
else
    unset PGPASSWORD
    echo -e "\n${RED}${BOLD}❌✗ Error:${NC} pg_dump failed 💥"
    exit 1
fi
