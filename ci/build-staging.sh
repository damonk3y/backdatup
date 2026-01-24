#!/bin/bash

set -e

# ═══════════════════════════════════════════════════════════════════════════════
# Colors & Formatting
# ═══════════════════════════════════════════════════════════════════════════════
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'
GREEN='\033[38;5;114m'
BLUE='\033[38;5;110m'
YELLOW='\033[38;5;221m'
RED='\033[38;5;204m'
CYAN='\033[38;5;117m'
MAGENTA='\033[38;5;183m'

# ═══════════════════════════════════════════════════════════════════════════════
# Logging Functions
# ═══════════════════════════════════════════════════════════════════════════════
header() {
    echo ""
    echo -e "${BOLD}${BLUE}╭─────────────────────────────────────────────────────────────╮${RESET}"
    echo -e "${BOLD}${BLUE}│${RESET}  $1"
    echo -e "${BOLD}${BLUE}╰─────────────────────────────────────────────────────────────╯${RESET}"
}

step() {
    echo ""
    echo -e "  ${CYAN}▸${RESET} ${BOLD}$1${RESET}"
    echo -e "  ${DIM}─────────────────────────────────────────────────────────${RESET}"
}

info()    { echo -e "    ${DIM}$1${RESET}"; }
success() { echo -e "    ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "    ${YELLOW}⚠${RESET} $1"; }
fail()    { echo -e "    ${RED}✗${RESET} $1"; exit 1; }

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════════
REGISTRY="${DOCKER_REGISTRY:-192.168.0.100:5100}"
IMAGE_NAME="backdatup"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMESTAMP=$(date +%s)

# ═══════════════════════════════════════════════════════════════════════════════
# Build Pipeline
# ═══════════════════════════════════════════════════════════════════════════════
header "Building ${MAGENTA}${IMAGE_NAME}${RESET}"

info "Registry      ${REGISTRY}"
info "Timestamp     ${TIMESTAMP}"
info "Project Root  ${PROJECT_ROOT}"

# ─────────────────────────────────────────────────────────────────────────────────
step "Validating project structure"

cd "$PROJECT_ROOT"

if [ ! -f "webui/Dockerfile" ]; then
    fail "Dockerfile not found at webui/Dockerfile"
fi

if [ ! -f "webui/package.json" ]; then
    fail "package.json not found at webui/package.json"
fi

if [ ! -f "Makefile" ]; then
    fail "Makefile not found in project root"
fi

success "Project structure validated"

# ─────────────────────────────────────────────────────────────────────────────────
step "Setting up multi-arch builder"

BUILDKIT_CONFIG=$(mktemp)
cat > "$BUILDKIT_CONFIG" << TOML
[registry."${REGISTRY}"]
  http = true
  insecure = true
TOML

BUILDER_NAME="backdatup-builder"

if docker buildx inspect "$BUILDER_NAME" &> /dev/null; then
    info "Removing existing builder..."
    docker buildx rm "$BUILDER_NAME" > /dev/null 2>&1 || true
fi

docker buildx create \
    --name "$BUILDER_NAME" \
    --use \
    --config "$BUILDKIT_CONFIG" \
    > /dev/null 2>&1 || fail "Failed to create buildx builder"

rm -f "$BUILDKIT_CONFIG"
success "Created ${BUILDER_NAME} with insecure registry support"

# ─────────────────────────────────────────────────────────────────────────────────
step "Building and pushing multi-arch image"

info "Platforms: linux/amd64, linux/arm64"
info "Tags: ${TIMESTAMP}, latest"

docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --push \
    -f webui/Dockerfile \
    -t "${REGISTRY}/${IMAGE_NAME}:${TIMESTAMP}" \
    -t "${REGISTRY}/${IMAGE_NAME}:latest" \
    . || fail "Build/push failed"

success "Built and pushed ${REGISTRY}/${IMAGE_NAME}:${TIMESTAMP}"
success "Built and pushed ${REGISTRY}/${IMAGE_NAME}:latest"

# ─────────────────────────────────────────────────────────────────────────────────
step "Cleanup"

docker buildx rm "$BUILDER_NAME" > /dev/null 2>&1 || true
success "Removed buildx builder"

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}${GREEN}╭─────────────────────────────────────────────────────────────╮${RESET}"
echo -e "${BOLD}${GREEN}│${RESET}  ${GREEN}✓${RESET}  Build complete"
echo -e "${BOLD}${GREEN}│${RESET}"
echo -e "${BOLD}${GREEN}│${RESET}     ${DIM}Image${RESET}       ${REGISTRY}/${IMAGE_NAME}"
echo -e "${BOLD}${GREEN}│${RESET}     ${DIM}Tags${RESET}        latest, ${TIMESTAMP}"
echo -e "${BOLD}${GREEN}│${RESET}     ${DIM}Platforms${RESET}   linux/amd64, linux/arm64"
echo -e "${BOLD}${GREEN}╰─────────────────────────────────────────────────────────────╯${RESET}"
echo ""
