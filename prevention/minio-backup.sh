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
    echo -e "${RED}${BOLD}Error:${NC} .env file not found in ${CYAN}$PROJECT_ROOT${NC}"
    exit 1
fi

source "$PROJECT_ROOT/.env"

required_vars=("MINIO_ENDPOINT" "MINIO_ACCESS_KEY" "MINIO_SECRET_KEY" "ENVIRONMENT")
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo -e "${RED}${BOLD}Error:${NC} Required environment variable ${YELLOW}$var${NC} is not set"
        exit 1
    fi
done

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "prod" ]]; then
    echo -e "${RED}${BOLD}Error:${NC} ENVIRONMENT must be ${YELLOW}staging${NC} or ${YELLOW}prod${NC}"
    exit 1
fi

DUMP_DIR="$PROJECT_ROOT/dumps/$ENVIRONMENT/minio"
TIMESTAMP=$(date +"%Y_%m%d_%H%M%S")
MC_ALIAS="backdatup_minio"

mkdir -p "$DUMP_DIR"

echo -e "${CYAN}${BOLD}======================================================${NC}"
echo -e "${BOLD}Starting MinIO Backup${NC}\n"
echo -e "${BOLD}Environment:${NC} ${YELLOW}${ENVIRONMENT}${NC}"
echo -e "${BOLD}Endpoint  :${NC} ${YELLOW}${MINIO_ENDPOINT}${NC}"
echo -e "${BOLD}Output    :${NC} ${YELLOW}${DUMP_DIR}${NC}"
echo -e "${BOLD}Timestamp :${NC} ${YELLOW}${TIMESTAMP}${NC}"
echo -e "${CYAN}${BOLD}======================================================${NC}"

if ! command -v mc &> /dev/null; then
    echo -e "${RED}${BOLD}Error:${NC} MinIO client (mc) is not installed"
    echo -e "Install with: ${YELLOW}brew install minio/stable/mc${NC} or download from ${YELLOW}https://min.io/docs/minio/linux/reference/minio-mc.html${NC}"
    exit 1
fi

echo -e "\n${CYAN}Configuring MinIO client...${NC}"
mc alias set "$MC_ALIAS" "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" --api S3v4 > /dev/null

echo -e "\n${CYAN}Fetching bucket list...${NC}"
BUCKETS=$(mc ls "$MC_ALIAS" --json 2>/dev/null | grep -o '"key":"[^"]*"' | cut -d'"' -f4 | sed 's/\/$//')

if [ -z "$BUCKETS" ]; then
    echo -e "${YELLOW}No buckets found on MinIO server${NC}"
    mc alias rm "$MC_ALIAS" > /dev/null 2>&1 || true
    exit 0
fi

BUCKET_COUNT=$(echo "$BUCKETS" | wc -l | tr -d ' ')
echo -e "${GREEN}Found ${BUCKET_COUNT} bucket(s)${NC}"

TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR; mc alias rm $MC_ALIAS > /dev/null 2>&1 || true" EXIT

SUCCESS_COUNT=0
FAIL_COUNT=0
SKIPPED_COUNT=0

for BUCKET in $BUCKETS; do
    echo -e "\n${CYAN}${BOLD}Processing bucket:${NC} ${YELLOW}${BUCKET}${NC}"

    OBJECT_COUNT=$(mc ls --recursive "$MC_ALIAS/$BUCKET/" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$OBJECT_COUNT" -eq 0 ]; then
        echo -e "  ${YELLOW}Skipping empty bucket${NC}"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
    fi

    BUCKET_TEMP="$TEMP_DIR/$BUCKET"
    mkdir -p "$BUCKET_TEMP"

    echo -e "  Downloading contents..."
    if mc cp --recursive "$MC_ALIAS/$BUCKET/" "$BUCKET_TEMP/" > /dev/null 2>&1; then
        TAR_NAME="${BUCKET}_${TIMESTAMP}.tar.gz"
        TAR_PATH="$DUMP_DIR/$TAR_NAME"

        echo -e "  Creating archive..."
        if tar -czf "$TAR_PATH" -C "$TEMP_DIR" "$BUCKET"; then
            SIZE=$(du -h "$TAR_PATH" | cut -f1)
            echo -e "  ${GREEN}Created:${NC} ${TAR_NAME} (${SIZE})"
            SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        else
            echo -e "  ${RED}Failed to create archive${NC}"
            FAIL_COUNT=$((FAIL_COUNT + 1))
        fi
    else
        echo -e "  ${RED}Failed to download bucket contents${NC}"
        ((FAIL_COUNT++))
    fi

    rm -rf "$BUCKET_TEMP"
done

echo -e "\n${CYAN}${BOLD}======================================================${NC}"
echo -e "${BOLD}Backup Summary${NC}"
echo -e "${CYAN}${BOLD}======================================================${NC}"
echo -e "${GREEN}Successful:${NC} ${SUCCESS_COUNT}"
if [ "$SKIPPED_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}Skipped:${NC}    ${SKIPPED_COUNT} (empty buckets)"
fi
if [ "$FAIL_COUNT" -gt 0 ]; then
    echo -e "${RED}Failed:${NC}     ${FAIL_COUNT}"
fi
echo -e "${BOLD}Location:${NC}   ${DUMP_DIR}"

if [ "$SUCCESS_COUNT" -gt 0 ]; then
    echo -e "\n${CYAN}Recent backups:${NC}"
    ls -lht "$DUMP_DIR"/*.tar.gz 2>/dev/null | head -10
fi

echo -e "${CYAN}${BOLD}======================================================${NC}\n"

if [ "$FAIL_COUNT" -gt 0 ] && [ "$SUCCESS_COUNT" -eq 0 ]; then
    exit 1
fi
