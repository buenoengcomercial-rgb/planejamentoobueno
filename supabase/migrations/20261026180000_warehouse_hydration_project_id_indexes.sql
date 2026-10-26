-- Operational hydration filters by project_id and paginates by id.
-- The existing (project_id, created_at/occurred_at) indexes cannot serve
-- that ordering without an additional sort.
CREATE INDEX IF NOT EXISTS warehouse_requisitions_project_id_idx
  ON public.warehouse_requisitions (project_id, id);

CREATE INDEX IF NOT EXISTS warehouse_movements_project_id_idx
  ON public.warehouse_movements (project_id, id);

CREATE INDEX IF NOT EXISTS warehouse_custody_project_id_idx
  ON public.warehouse_custody (project_id, id);
