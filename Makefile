backup:
	bash prevention/minio-backup.sh
	bash prevention/psql-backup.sh

restore:
	bash recovery/restore-psql.sh

persist:
	bash storage/persist-dumps.sh

cleanup:
	bash storage/cleanup.sh

e2e-run:
	make backup
	make persist
	make restore
	make cleanup
