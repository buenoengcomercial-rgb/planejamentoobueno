
CREATE OR REPLACE FUNCTION public.strip_task_logs(node jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  result jsonb;
  kids jsonb;
BEGIN
  IF node IS NULL OR jsonb_typeof(node) <> 'object' THEN
    RETURN node;
  END IF;
  result := node - 'dailyLogs';
  IF (result ? 'children') AND jsonb_typeof(result->'children') = 'array' THEN
    SELECT COALESCE(jsonb_agg(public.strip_task_logs(c)), '[]'::jsonb)
      INTO kids
      FROM jsonb_array_elements(result->'children') c;
    result := jsonb_set(result, '{children}', kids);
  END IF;
  IF (result ? 'tasks') AND jsonb_typeof(result->'tasks') = 'array' THEN
    SELECT COALESCE(jsonb_agg(public.strip_task_logs(t)), '[]'::jsonb)
      INTO kids
      FROM jsonb_array_elements(result->'tasks') t;
    result := jsonb_set(result, '{tasks}', kids);
  END IF;
  RETURN result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.strip_task_logs(jsonb) FROM anon, authenticated;
