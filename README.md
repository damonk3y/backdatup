# BackDatUp

A PostgreSQL backup automation tool that creates parallel database dumps, persists them to RAID storage, and manages backup lifecycle with intelligent cleanup.

## Features

- **Parallel Backups** - Uses `pg_dump` directory format with multi-threaded compression
- **RAID Persistence** - Copies backups to RAID storage with file-level deduplication
- **Error-Tolerant Restore** - Handles PostgreSQL version compatibility warnings gracefully
- **Smart Cleanup** - Retention-based deletion that always keeps the 3 most recent backups

## Requirements

- PostgreSQL client tools (`pg_dump`, `pg_restore`)
- Bash shell
- RAID storage mount point (for persistence)

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/backdatup.git
   cd backdatup
   ```

2. Create your environment file:
   ```bash
   cp .env.example .env
   ```

3. Configure your `.env` file:
   ```bash
   RAID_PATH=/path/to/raid/mount
   POSTGRES_USER=your_user
   POSTGRES_PASSWORD=your_password
   POSTGRES_HOST=localhost
   POSTGRES_PORT=5432
   POSTGRES_DB=your_database
   ```

## Usage

### Individual Commands

```bash
# Create a database backup
make backup

# Copy backups to RAID storage
make persist

# Restore from the latest RAID backup
make restore

# Clean up old backups (keeps 3 most recent, deletes >2 days old)
make cleanup
```

### Full Workflow

Run the complete backup cycle:

```bash
make e2e-run
```

This executes: backup → persist → restore → cleanup

## How It Works

### Backup Process (`prevention/psql-backup.sh`)

Creates a PostgreSQL dump using directory format for parallel processing:
- Detects available CPU cores (caps at 4 parallel jobs)
- Compresses with gzip level 1 for speed
- Names backups as `{DB_NAME}_{YYYY}_{MMDD}_{HHMMSS}`
- Stores in local `dumps/psql/` directory

### Persistence (`storage/persist-dumps.sh`)

Copies local dumps to RAID storage:
- Target location: `{RAID_PATH}/backthatup/`
- Skips files that already exist with matching size
- Reports progress every 10 files
- Tracks copied/skipped/failed statistics

### Restoration (`recovery/restore-psql.sh`)

Restores the database from the latest RAID backup:
- Automatically finds the most recent backup
- Uses parallel restore with up to 4 jobs
- Tolerates version compatibility warnings
- Uses `--clean --if-exists` for safe restoration

### Cleanup (`storage/cleanup.sh`)

Manages backup retention on RAID storage:
- Always preserves the 3 most recent backups
- Deletes backups older than 2 days (if more than 3 exist)
- Reports space freed
- Cleans local dump directory after successful RAID cleanup

## Directory Structure

```
backdatup/
├── prevention/
│   └── psql-backup.sh      # Backup creation
├── recovery/
│   └── restore-psql.sh     # Database restoration
├── storage/
│   ├── persist-dumps.sh    # RAID persistence
│   └── cleanup.sh          # Backup lifecycle management
├── Makefile                # Command orchestration
├── .env.example            # Configuration template
└── dumps/                  # Local backup staging (gitignored)
```

## Backup Format

Backups use PostgreSQL's directory format (`-Fd`), which creates:

```
{DB_NAME}_{TIMESTAMP}/
├── toc.dat          # Table of contents
├── restore.sql      # Restore script
└── *.dat.gz         # Compressed table data
```

This format enables parallel backup/restore and efficient storage.

## License

MIT
