-- Criação atômica de obras no modelo contratual V2.
-- A função é SECURITY INVOKER: todas as políticas RLS continuam valendo.
CREATE OR REPLACE FUNCTION public.create_contract_project_v2(
  p_project_id uuid,
  p_organization_id uuid,
  p_name text,
  p_data jsonb,
  p_budget_items jsonb,
  p_analytic_compositions jsonb,
  p_chapters jsonb,
  p_tasks jsonb
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  row_data jsonb;
  saved_at timestamptz;
BEGIN
  IF COALESCE(NULLIF(p_data->>'contractSchemaVersion', '')::integer, 0) <> 2 THEN
    RAISE EXCEPTION 'A criação transacional exige contractSchemaVersion = 2';
  END IF;

  IF jsonb_typeof(COALESCE(p_budget_items, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_analytic_compositions, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_chapters, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_tasks, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Estrutura contratual inválida: as coleções devem ser listas';
  END IF;

  INSERT INTO public.projects (id, organization_id, name, data_json)
  VALUES (p_project_id, p_organization_id, p_name, p_data)
  RETURNING updated_at INTO saved_at;

  FOR row_data IN SELECT value FROM jsonb_array_elements(COALESCE(p_budget_items, '[]'::jsonb))
  LOOP
    INSERT INTO public.budget_items (
      id, project_id, item, code, source, task_id, additive_id, data, created_by
    ) VALUES (
      row_data->>'id',
      p_project_id,
      row_data->>'item',
      row_data->>'code',
      row_data->>'source',
      row_data->>'task_id',
      row_data->>'additive_id',
      COALESCE(row_data->'data', '{}'::jsonb),
      auth.uid()
    );
  END LOOP;

  FOR row_data IN SELECT value FROM jsonb_array_elements(COALESCE(p_analytic_compositions, '[]'::jsonb))
  LOOP
    INSERT INTO public.analytic_compositions (
      id, project_id, code, data, created_by
    ) VALUES (
      row_data->>'id',
      p_project_id,
      row_data->>'code',
      COALESCE(row_data->'data', '{}'::jsonb),
      auth.uid()
    );
  END LOOP;

  FOR row_data IN SELECT value FROM jsonb_array_elements(COALESCE(p_chapters, '[]'::jsonb))
  LOOP
    INSERT INTO public.eap_chapters (
      id, project_id, parent_id, order_index, name, data, created_by
    ) VALUES (
      row_data->>'id',
      p_project_id,
      NULLIF(row_data->>'parent_id', ''),
      COALESCE(NULLIF(row_data->>'order_index', '')::integer, 0),
      row_data->>'name',
      COALESCE(row_data->'data', '{}'::jsonb),
      auth.uid()
    );
  END LOOP;

  FOR row_data IN SELECT value FROM jsonb_array_elements(COALESCE(p_tasks, '[]'::jsonb))
  LOOP
    INSERT INTO public.tasks (
      id, project_id, chapter_id, parent_task_id, order_index, name,
      start_date, duration_days, percent_complete, data, created_by
    ) VALUES (
      row_data->>'id',
      p_project_id,
      row_data->>'chapter_id',
      NULLIF(row_data->>'parent_task_id', ''),
      COALESCE(NULLIF(row_data->>'order_index', '')::integer, 0),
      row_data->>'name',
      NULLIF(row_data->>'start_date', '')::date,
      NULLIF(row_data->>'duration_days', '')::numeric,
      NULLIF(row_data->>'percent_complete', '')::numeric,
      COALESCE(row_data->'data', '{}'::jsonb),
      auth.uid()
    );
  END LOOP;

  RETURN saved_at;
END;
$$;

REVOKE ALL ON FUNCTION public.create_contract_project_v2(
  uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_contract_project_v2(
  uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb
) TO authenticated;
