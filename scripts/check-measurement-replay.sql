-- psql -v project_id=... -v expected_hash=... -f scripts/check-measurement-replay.sql
-- Obtain expected_hash on the same stable revision before changing the function.
-- This checks the actual PostgreSQL runtime budget, which PGlite cannot model.
BEGIN;
SET LOCAL statement_timeout = '3s';
SELECT md5(public.materialize_measurement_workspace(:'project_id'::uuid)::text) = :'expected_hash' AS full_document_unchanged;
ROLLBACK;
