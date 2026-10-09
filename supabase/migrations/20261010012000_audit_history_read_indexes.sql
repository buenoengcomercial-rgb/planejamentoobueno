-- Summary pagination and lazy details; no payload or permission changes.
CREATE INDEX IF NOT EXISTS audit_history_entity_page
ON public.audit_logs (project_id, entity_type, entity_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_history_legacy_entity_page
ON public.audit_logs (project_id, (data->>'entityType'), (data->>'entityId'), occurred_at DESC, id DESC);
