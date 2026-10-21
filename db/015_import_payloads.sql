-- Keep the uploaded text with the job so an unrecognised layout can be re-run once a mapping
-- is supplied (POST /imports/{id}/mapping) without asking for the file again. Documents/MinIO
-- will take over storage later; this column is cleared once a job is done.
alter table import_jobs add column if not exists payload text;
