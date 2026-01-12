# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BackDatUp is a backup automation tool for PostgreSQL databases and MinIO object storage. It creates parallel database dumps, backs up MinIO buckets, persists them to RAID storage, restores from backups with error tolerance, and manages backup lifecycle with intelligent cleanup.

## Commands

```bash
make backup       # Create PostgreSQL dump + MinIO bucket backups
make restore      # Restore PostgreSQL + MinIO from RAID
make persist      # Copy local dumps to RAID (with type-aware stats)
make cleanup      # Remove old backups from RAID (PostgreSQL + MinIO)
make e2e-run      # Full workflow: backup -> persist -> restore -> cleanup

# Individual service commands
make backup-psql    # PostgreSQL backup only
make backup-minio   # MinIO backup only
make restore-psql   # PostgreSQL restore only
make restore-minio  # MinIO restore only
```

## Requirements

- PostgreSQL client tools (`pg_dump`, `pg_restore`)
- MinIO client (`mc`) - install via `brew install minio/stable/mc`
- Bash shell

## Architecture

The codebase is organized by backup workflow stages:

- **prevention/** - Backup creation
  - `psql-backup.sh` - PostgreSQL using `pg_dump` with directory format and parallel jobs
  - `minio-backup.sh` - MinIO buckets using `mc` client, creates `.tar.gz` archives per bucket
- **recovery/** - Restoration
  - `restore-psql.sh` - PostgreSQL using `pg_restore` with error tolerance for version compatibility
  - `restore-minio.sh` - MinIO buckets using `mc` client, extracts and uploads from archives
- **storage/** - RAID persistence with file-level deduplication and retention-based cleanup (supports both PostgreSQL and MinIO)

### Key Design Decisions

- All scripts use `set -e` for strict error handling
- Parallel operations are capped at 4 jobs regardless of CPU count
- Backup naming: PostgreSQL `{DB_NAME}_{YYYYMMDD}_{HHMMSS}`, MinIO `{bucket}_{YYYY}_{MMDD}_{HHMMSS}.tar.gz`
- Cleanup policy: keeps 3 most recent backups, deletes those older than 2 days
- Restore tolerates `unrecognized configuration parameter` errors (version compatibility)
- MinIO client alias is configured per-script (`backdatup_minio` for backup, `backdatup_minio_restore` for restore)

## Configuration

Scripts require a `.env` file with:
- `RAID_PATH` - RAID mount point
- `ENVIRONMENT` - Environment name (`staging` or `prod`) - separates backups by environment
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB` - PostgreSQL connection
- `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` - MinIO connection

See `.env.example` for template.

## Local Directories

Backups are organized by environment:

- `dumps/{ENVIRONMENT}/psql/` - Local PostgreSQL backup staging
- `dumps/{ENVIRONMENT}/minio/` - Local MinIO backup staging (`.tar.gz` archives)
- `{RAID_PATH}/backthatup/{ENVIRONMENT}/psql/` - Long-term PostgreSQL RAID storage
- `{RAID_PATH}/backthatup/{ENVIRONMENT}/minio/` - Long-term MinIO RAID storage

Where `{ENVIRONMENT}` is either `staging` or `prod`.
