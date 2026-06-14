# Restoring Backups

This guide explains how to restore PostgreSQL databases and MinIO buckets from BackDatUp backups.

Restore is a **manual / recovery operation**. It is intentionally not part of the normal scheduled backup jobs (which focus on `backup` → `persist` → `cleanup`).

## Prerequisites

- PostgreSQL client tools (`pg_restore`)
- (For MinIO) MinIO client `mc` (`brew install minio/stable/mc`)
- A `.env` file (or `BACKDATUP_ENV_FILE`) with the correct connection details and `RAID_PATH`
- The target database / MinIO instance must be reachable
- For downloaded backups: `tar` and `pg_restore`

> **Tip**: The Web UI only handles backup creation and downloading artifacts. Restore is performed with the scripts below (or manually with `pg_restore`).

---

## 1. Restore the Latest Backup (Easiest)

When you are on a machine that has the RAID mounted and the BackDatUp checkout:

```bash
# PostgreSQL only
make restore-psql

# MinIO only
make restore-minio

# Both
make restore
```

The scripts will:
- Automatically find the most recent backup for your `POSTGRES_DB` (or all latest-per-bucket for MinIO)
- Use parallel restore (`-j`)
- Tolerate some version-compatibility warnings from `pg_restore` (see troubleshooting)
- Use `--clean --if-exists` so it can restore over an existing database

**Warning**: This will **drop and recreate** objects in the target database.

---

## 2. Restore a Specific or Downloaded Backup (Common After Using the Web UI)

This is the main use case after clicking **Download** in a job's detail view in the Web UI.

### Step-by-step for a PostgreSQL backup you downloaded

1. In the Web UI, go to **Jobs** → click a job → scroll to **Backups on RAID** → click **Download** on the backup you want.

   You will receive a file like:
   - `mydb_20260614_151200.tar.gz` (this is a tarball of the directory-format dump)

2. On the machine where you want to perform the restore, extract it:

   ```bash
   tar -xzf mydb_20260614_151200.tar.gz
   # This creates a directory: mydb_20260614_151200/
   ```

3. Restore using `pg_restore` directly (recommended for one-off / downloaded cases):

   ```bash
   # Basic restore (will drop existing objects)
   pg_restore \
     -h your-db-host \
     -p 5432 \
     -U your_user \
     -d target_database \
     --no-owner \
     --no-acl \
     --clean \
     --if-exists \
     -j 4 \
     ./mydb_20260614_151200/
   ```

   Export the password first if needed:
   ```bash
   export PGPASSWORD=your_password
   ```

### Using the BackDatUp scripts with a specific backup (advanced)

You can temporarily override variables:

```bash
# Restore this specific extracted directory instead of the latest on RAID
POSTGRES_DB=mydb \
RAID_PATH=/tmp \
ENVIRONMENT=whatever \
bash recovery/restore-psql.sh
```

> Note: The script still looks under `$RAID_PATH/backthatup/$ENVIRONMENT/psql/`. For truly arbitrary locations, the direct `pg_restore` command above is simpler.

---

## 3. Restore to a Different Database Name

Very common when you want to inspect or test a backup without touching the original database.

### Option A — Direct pg_restore (most flexible)

```bash
pg_restore \
  -h localhost \
  -p 5432 \
  -U postgres \
  -d mydb_backup_20260614 \
  --no-owner --no-acl --clean --if-exists -j 4 \
  ./mydb_20260614_151200/
```

Create the target database first if it doesn't exist:

```bash
createdb -h localhost -U postgres mydb_backup_20260614
```

### Option B — Using the scripts

Edit your `.env` (or use inline overrides):

```bash
POSTGRES_DB=mydb_backup_20260614 make restore-psql
```

Or create a temporary env file:

```bash
cp .env .env.restore-test
# edit POSTGRES_DB in .env.restore-test
BACKDATUP_ENV_FILE=.env.restore-test make restore-psql
```

---

## 4. MinIO Restore

Similar flow:

```bash
make restore-minio
```

The script restores the **latest** version of each bucket it finds (one archive per bucket).

If you downloaded a specific `.tar.gz` from the UI (e.g. `client-thumbnails_2026_0110_151530.tar.gz`):

1. Extract it to get the bucket contents.
2. Use `mc` directly:

   ```bash
   mc alias set myminio https://your-minio:9000 ACCESS SECRET
   mc cp --recursive ./client-thumbnails/ myminio/client-thumbnails/
   ```

The official `restore-minio.sh` script handles bucket creation and uses a dedicated alias (`backdatup_minio_restore`).

---

## 5. Troubleshooting

### "unrecognized configuration parameter" warnings

This is **normal and expected** when restoring a dump taken on a newer PostgreSQL version than the target.

The `restore-psql.sh` script already detects this case and treats it as success as long as there are no real fatal errors.

You will see output like:

```
⚠️  Some configuration parameters were not recognized (version compatibility)
⚠️  pg_restore ignored 7 error(s) - restore likely succeeded
```

### pg_restore not found or version mismatch

Make sure the machine running restore has a `pg_restore` binary compatible enough with the source (newer `pg_restore` can usually read older dumps).

### Permission / ownership issues

The scripts use `--no-owner --no-acl` to avoid problems when the dump was taken as a different user.

### The script can't find any backup

- Make sure `RAID_PATH`, `ENVIRONMENT`, and `POSTGRES_DB` are correct.
- The backup must have been `persist`ed (it lives under `$RAID_PATH/backthatup/$ENVIRONMENT/psql/`).
- For downloaded backups, use the direct `pg_restore` method instead of relying on the RAID lookup logic.

### Restoring a very large database

The scripts cap parallel jobs at 4 (`-j 4`). You can temporarily increase it by editing the script or exporting `NUM_JOBS` before calling (the script reads it from the environment before capping).

---

## 6. Web UI + Restore Workflow

1. Use the Web UI to trigger backups (and optionally persist).
2. Use the **Backups on RAID** section in any job's detail view to browse history and download a specific point-in-time backup.
3. On a recovery / staging / developer machine:
   - Extract the downloaded archive
   - Use `pg_restore` (or the restore scripts with overrides) to bring it up under a safe database name.
4. Once verified, you can promote the data or copy it where needed.

Restore is deliberately kept as an explicit human decision because it is destructive.

---

## Summary of Useful Commands

| Goal                                | Command / Method                              |
|-------------------------------------|-----------------------------------------------|
| Restore latest (full checkout)      | `make restore-psql`                           |
| Restore specific downloaded backup  | `tar -xzf ...` then `pg_restore ... ./dir/`   |
| Restore to a test DB name           | Override `POSTGRES_DB` or use direct pg_restore |
| MinIO latest                        | `make restore-minio`                          |
| See what would be restored          | Look at the script output (it prints the chosen backup path) |

For the absolute latest details on the scripts, see:
- `recovery/restore-psql.sh`
- `recovery/restore-minio.sh`

Happy restoring! 🛠️