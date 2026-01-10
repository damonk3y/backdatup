backup:
	make backup-psql
	make backup-minio

backup-psql:
	bash prevention/psql-backup.sh

backup-minio:
	bash prevention/minio-backup.sh

restore:
	make restore-psql
	make restore-minio

restore-psql:
	bash recovery/restore-psql.sh

restore-minio:
	bash recovery/restore-minio.sh

persist:
	bash storage/persist-dumps.sh

cleanup:
	bash storage/cleanup.sh

e2e-run:
	make backup
	make persist
	make restore
	make cleanup
