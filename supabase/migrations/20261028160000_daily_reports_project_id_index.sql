-- A hidratação do Diário pagina por (project_id, id); os índices existentes
-- ordenam por report_date e não atendem esse cursor.
CREATE INDEX IF NOT EXISTS daily_reports_project_id_idx
  ON public.daily_reports (project_id, id);
