#!/bin/bash
#
# MinIO Restore Script
#
# Usage:
#   make restore-minio
#
# For a specific .tar.gz you downloaded from the Web UI, see RESTORE.md.
# You can also use mc directly after extracting the archive.
#
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

required_vars=("MINIO_ENDPOINT" "MINIO_ACCESS_KEY" "MINIO_SECRET_KEY" "RAID_PATH" "ENVIRONMENT")
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

BACKUP_DIR="${RAID_PATH}/backthatup/$ENVIRONMENT/minio"
MC_ALIAS="backdatup_minio_restore"

if [ ! -d "$RAID_PATH" ]; then
    error "RAID mount path not found: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

if [ ! -r "$RAID_PATH" ]; then
    error "RAID mount path is not readable: ${CYAN}$RAID_PATH${NC} 😱"
    exit 1
fi

if [ ! -d "$BACKUP_DIR" ]; then
    error "MinIO backup directory not found at ${CYAN}$BACKUP_DIR${NC} 😱"
    exit 1
fi

if ! command -v mc &> /dev/null; then
    error "MinIO client (mc) is not installed"
    echo -e "Install with: ${YELLOW}brew install minio/stable/mc${NC} or download from ${YELLOW}https://min.io/docs/minio/linux/reference/minio-mc.html${NC}"
    exit 1
fi

BACKUP_FILES=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.tar.gz" 2>/dev/null | sort -r)

if [ -z "$BACKUP_FILES" ]; then
    error "No MinIO backups found in ${CYAN}$BACKUP_DIR${NC} 😬"
    exit 1
fi

LATEST_BACKUPS=()
SEEN_BUCKETS=""
while IFS= read -r backup_file; do
    filename=$(basename "$backup_file")
    bucket_name=$(echo "$filename" | sed -E 's/_[0-9]{4}_[0-9]{4}_[0-9]{6}\.tar\.gz$//')
    if ! echo "$SEEN_BUCKETS" | grep -q "^${bucket_name}$"; then
        LATEST_BACKUPS+=("$backup_file")
        SEEN_BUCKETS="${SEEN_BUCKETS}${bucket_name}"$'\n'
    fi
done <<< "$BACKUP_FILES"

BUCKET_COUNT=${#LATEST_BACKUPS[@]}

echo -e "$divider"
echo -e "📦🔄 ${BOLD}Starting MinIO Restore Process${NC} 🚀"
info   "🏷️  Environment: ${YELLOW}${ENVIRONMENT}${NC}"
info   "🌐 Endpoint : ${YELLOW}${MINIO_ENDPOINT}${NC}"
info   "💿 Source   : ${YELLOW}${BACKUP_DIR}${NC}"
info   "📊 Buckets  : ${YELLOW}${BUCKET_COUNT}${NC} to restore"
echo -e "$divider"

echo -e "\n${CYAN}Configuring MinIO client...${NC}"
mc alias set "$MC_ALIAS" "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" --api S3v4 > /dev/null

TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR; mc alias rm $MC_ALIAS > /dev/null 2>&1 || true" EXIT

SUCCESS_COUNT=0
FAIL_COUNT=0
TOTAL_SIZE_RESTORED=0

for backup_file in "${LATEST_BACKUPS[@]}"; do
    filename=$(basename "$backup_file")
    bucket_name=$(echo "$filename" | sed -E 's/_[0-9]{4}_[0-9]{4}_[0-9]{6}\.tar\.gz$//')

    echo -e "\n${CYAN}${BOLD}Restoring bucket:${NC} ${YELLOW}${bucket_name}${NC}"
    echo -e "   📄 From: ${CYAN}${filename}${NC}"

    EXTRACT_DIR="$TEMP_DIR/$bucket_name"
    mkdir -p "$EXTRACT_DIR"

    echo -e "   📂 Extracting archive..."
    set +e
    EXTRACT_OUTPUT=$(tar -xzf "$backup_file" -C "$TEMP_DIR" 2>&1)
    EXTRACT_EXIT=$?
    set -e
    if [ $EXTRACT_EXIT -ne 0 ]; then
        echo -e "   ${RED}✗${NC} Failed to extract archive"
        echo -e "   ${RED}Error:${NC} $EXTRACT_OUTPUT"
        ((FAIL_COUNT++))
        continue
    fi

    set +e
    mc ls "$MC_ALIAS/$bucket_name" > /dev/null 2>&1
    BUCKET_EXISTS=$?
    set -e
    if [ $BUCKET_EXISTS -ne 0 ]; then
        echo -e "   🪣 Creating bucket..."
        set +e
        MB_OUTPUT=$(mc mb "$MC_ALIAS/$bucket_name" 2>&1)
        MB_EXIT=$?
        set -e
        if [ $MB_EXIT -ne 0 ]; then
            echo -e "   ${RED}✗${NC} Failed to create bucket"
            echo -e "   ${RED}Error:${NC} $MB_OUTPUT"
            ((FAIL_COUNT++))
            rm -rf "$EXTRACT_DIR"
            continue
        fi
    fi

    echo -e "   📤 Uploading contents..."
    echo -e "   ${CYAN}Source:${NC} $TEMP_DIR/$bucket_name/"
    echo -e "   ${CYAN}Target:${NC} $MC_ALIAS/$bucket_name/"

    if [ ! -d "$TEMP_DIR/$bucket_name" ]; then
        echo -e "   ${RED}✗${NC} Extracted directory not found: $TEMP_DIR/$bucket_name"
        echo -e "   ${YELLOW}Contents of temp dir:${NC}"
        ls -la "$TEMP_DIR/" 2>&1 | while read line; do echo -e "      $line"; done
        ((FAIL_COUNT++))
        continue
    fi

    set +e
    UPLOAD_OUTPUT=$(mc cp --recursive "$TEMP_DIR/$bucket_name/" "$MC_ALIAS/$bucket_name/" 2>&1)
    UPLOAD_EXIT=$?
    set -e
    if [ $UPLOAD_EXIT -eq 0 ]; then
        file_size=$(stat -f%z "$backup_file" 2>/dev/null || stat -c%s "$backup_file" 2>/dev/null || echo 0)
        TOTAL_SIZE_RESTORED=$((TOTAL_SIZE_RESTORED + file_size))
        SIZE=$(du -h "$backup_file" | cut -f1)
        echo -e "   ${GREEN}✓${NC} Restored ${YELLOW}${bucket_name}${NC} (${SIZE})"
        ((SUCCESS_COUNT++))
    else
        echo -e "   ${RED}✗${NC} Failed to upload contents (exit code: $UPLOAD_EXIT)"
        echo -e "   ${RED}Error:${NC} $UPLOAD_OUTPUT"
        ((FAIL_COUNT++))
    fi

    rm -rf "$TEMP_DIR/$bucket_name"
done

if [ "$TOTAL_SIZE_RESTORED" -gt 1073741824 ]; then
    GB_SIZE=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE_RESTORED / 1073741824}")
    SIZE_FORMATTED="${GB_SIZE} GB"
elif [ "$TOTAL_SIZE_RESTORED" -gt 1048576 ]; then
    MB_SIZE=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE_RESTORED / 1048576}")
    SIZE_FORMATTED="${MB_SIZE} MB"
elif [ "$TOTAL_SIZE_RESTORED" -gt 1024 ]; then
    KB_SIZE=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE_RESTORED / 1024}")
    SIZE_FORMATTED="${KB_SIZE} KB"
else
    SIZE_FORMATTED="${TOTAL_SIZE_RESTORED} bytes"
fi

echo -e "\n$divider"
echo -e "${BOLD}Restore Summary${NC}"
echo -e "$divider"
echo -e "${GREEN}Successful:${NC}   ${SUCCESS_COUNT}"
echo -e "${RED}Failed:${NC}       ${FAIL_COUNT}"
if [ "$SUCCESS_COUNT" -gt 0 ]; then
    echo -e "${BOLD}Size Restored:${NC} ${SIZE_FORMATTED}"
fi
echo -e "$divider"

if [ "$SUCCESS_COUNT" -gt 0 ] && [ "$FAIL_COUNT" -eq 0 ]; then
    echo -e "\n${GREEN}${BOLD}🎉 MinIO restore completed successfully! 🚀${NC}\n"
elif [ "$SUCCESS_COUNT" -gt 0 ]; then
    echo -e "\n${YELLOW}${BOLD}⚠️  MinIO restore completed with some failures${NC}\n"
    exit 1
else
    echo -e "\n${RED}${BOLD}🛑 MinIO restore failed${NC}\n"
    exit 1
fi
