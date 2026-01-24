FROM oven/bun:1-alpine

# Install PostgreSQL client and MinIO client (multi-arch)
RUN apk add --no-cache postgresql-client bash curl make \
    && ARCH=$(uname -m) \
    && case "$ARCH" in \
        x86_64) MC_ARCH="amd64" ;; \
        aarch64) MC_ARCH="arm64" ;; \
        *) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
    esac \
    && curl -O https://dl.min.io/client/mc/release/linux-${MC_ARCH}/mc \
    && chmod +x mc && mv mc /usr/local/bin/

WORKDIR /app

# Copy backup scripts
COPY prevention/ /app/prevention/
COPY recovery/ /app/recovery/
COPY storage/ /app/storage/
COPY Makefile /app/

# Install dependencies with Bun
COPY webui/package.json webui/bun.lockb* ./webui/
RUN cd webui && bun install --production

# Copy web UI source
COPY webui/src/ ./webui/src/
COPY webui/public/ ./webui/public/

# Create data directory
RUN mkdir -p /app/webui/data

EXPOSE 3000

# Data volume for SQLite
VOLUME /app/webui/data

ENV DB_PATH=/app/webui/data/backdatup.db

WORKDIR /app/webui

CMD ["bun", "run", "src/server.js"]
