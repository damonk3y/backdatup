# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BackDatUp is a PostgreSQL database backup automation tool that creates parallel database dumps, persists them to RAID storage, restores from backups with error tolerance, and manages backup lifecycle with intelligent cleanup.

## Commands

```bash
make backup       # Create PostgreSQL dump (prevention/psql-backup.sh)
make restore      # Restore database from RAID (recovery/restore-psql.sh)
make persist      # Copy local dumps to RAID (storage/persist-dumps.sh)
make cleanup      # Remove old backups from RAID (storage/cleanup.sh)
make e2e-run      # Full workflow: backup -> persist -> restore -> cleanup
```

## Architecture

The codebase is organized by backup workflow stages:

- **prevention/** - Backup creation using `pg_dump` with directory format and parallel jobs
- **recovery/** - Database restoration using `pg_restore` with error tolerance for version compatibility
- **storage/** - RAID persistence with file-level deduplication and retention-based cleanup

### Key Design Decisions

- All scripts use `set -e` for strict error handling
- Parallel operations are capped at 4 jobs regardless of CPU count
- Backup naming: `{DB_NAME}_{YYYY}_{MMDD}_{HHMMSS}`
- Cleanup policy: keeps 3 most recent backups, deletes those older than 2 days
- Restore tolerates `unrecognized configuration parameter` errors (version compatibility)

## Configuration

Scripts require a `.env` file with:
- `RAID_PATH` - RAID mount point
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`

See `.env.example` for template.

## Local Directories

- `dumps/psql/` - Local backup staging (created by backup, cleaned after RAID persist)
- `{RAID_PATH}/backthatup/` - Long-term RAID storage location
