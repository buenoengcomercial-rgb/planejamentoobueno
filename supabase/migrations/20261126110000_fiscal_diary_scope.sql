-- O cadastro da obra contém dados de todos os módulos. O perfil fiscal lê
-- somente a projeção do Diário por estas funções, sem SELECT no cadastro.
DROP POLICY IF EXISTS projects_select_member ON public.projects;
CREATE POLICY projects_select_member ON public.projects FOR SELECT TO authenticated USING (
  public.has_org_role(auth.uid(), organization_id,
    ARRAY['owner','admin','engineer','warehouse_operator','field_user','viewer']::public.org_role[])
);

-- Políticas antigas que aceitavam qualquer membro não podem abrir coleções
-- de outros módulos ao novo perfil. A consulta do Diário usa projeções próprias.
CREATE OR REPLACE FUNCTION public.is_org_member(_user_id uuid, _org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = _user_id AND organization_id = _org_id
      AND status = 'active' AND role <> 'fiscal'::public.org_role
  );
$$;
DROP POLICY IF EXISTS org_select_member ON public.organizations;
CREATE POLICY org_select_member ON public.organizations FOR SELECT TO authenticated USING (
  public.is_org_member(auth.uid(), id)
  OR public.has_org_role(auth.uid(), id, ARRAY['fiscal']::public.org_role[])
);

CREATE OR REPLACE FUNCTION app_private.fiscal_project_access(p_project_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
      AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['fiscal']::public.org_role[])
  );
$$;
REVOKE ALL ON FUNCTION app_private.fiscal_project_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.fiscal_project_access(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.fiscal_project_access(p_project_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id::text = p_project_id
      AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['fiscal']::public.org_role[])
  );
$$;
REVOKE ALL ON FUNCTION app_private.fiscal_project_access(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.fiscal_project_access(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.fiscal_diary_projects()
RETURNS TABLE (id uuid, name text, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id, p.name, p.updated_at FROM public.projects p
  WHERE public.has_org_role(auth.uid(), p.organization_id, ARRAY['fiscal']::public.org_role[])
  ORDER BY p.name;
$$;
REVOKE ALL ON FUNCTION public.fiscal_diary_projects() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fiscal_diary_projects() TO authenticated;

CREATE OR REPLACE FUNCTION public.fiscal_diary_report(p_project_id uuid, p_date date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_report jsonb;
  v_production jsonb;
BEGIN
  IF NOT app_private.fiscal_project_access(p_project_id) THEN
    RAISE EXCEPTION 'Sem acesso ao Diário desta obra' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'id', d.id, 'date', d.report_date,
    'noProductionDeclared', d.data->'noProductionDeclared',
    'responsible', d.data->'responsible',
    'weather', d.data->'weather', 'weatherOther', d.data->'weatherOther',
    'workCondition', d.data->'workCondition', 'workConditionOther', d.data->'workConditionOther',
    'teamsPresent', d.data->'teamsPresent', 'equipment', d.data->'equipment',
    'occurrences', d.data->'occurrences', 'impediments', d.data->'impediments',
    'observations', d.data->'observations', 'attachments', d.data->'attachments',
    'concludedAt', d.data->'concludedAt'
  ) INTO v_report
  FROM public.daily_reports d WHERE d.project_id = p_project_id AND d.report_date = p_date;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'taskId', l.task_id, 'taskName', coalesce(t.name, l.task_id),
    'actualQuantity', l.data->'actualQuantity', 'notes', l.data->'notes'
  )), '[]'::jsonb)
    INTO v_production
  FROM public.task_daily_logs l
  LEFT JOIN public.tasks t ON t.project_id = l.project_id AND t.id = l.task_id
  WHERE l.project_id = p_project_id AND l.log_date = p_date;
  RETURN jsonb_build_object('report', v_report, 'production', v_production);
END;
$$;
REVOKE ALL ON FUNCTION public.fiscal_diary_report(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fiscal_diary_report(uuid, date) TO authenticated;

-- As políticas abaixo precisam localizar a obra sem conceder o seu JSON.
DROP POLICY IF EXISTS fiscal_notes_read ON public.daily_report_fiscal_notes;
CREATE POLICY fiscal_notes_read ON public.daily_report_fiscal_notes FOR SELECT TO authenticated USING (
  app_private.fiscal_project_access(project_id)
  OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id
    AND public.is_org_member(auth.uid(), p.organization_id))
);
DROP POLICY IF EXISTS fiscal_notes_insert ON public.daily_report_fiscal_notes;
CREATE POLICY fiscal_notes_insert ON public.daily_report_fiscal_notes FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid() AND app_private.fiscal_project_access(project_id));
DROP POLICY IF EXISTS fiscal_notes_update ON public.daily_report_fiscal_notes;
CREATE POLICY fiscal_notes_update ON public.daily_report_fiscal_notes FOR UPDATE TO authenticated
  USING (author_id = auth.uid() AND app_private.fiscal_project_access(project_id))
  WITH CHECK (author_id = auth.uid() AND app_private.fiscal_project_access(project_id));

DROP POLICY IF EXISTS fiscal_photo_read ON storage.objects;
CREATE POLICY fiscal_photo_read ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'daily-report-fiscal-photos' AND (
    app_private.fiscal_project_access((storage.foldername(storage.objects.name))[1])
    OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.is_org_member(auth.uid(), p.organization_id))
  )
);
DROP POLICY IF EXISTS fiscal_photo_insert ON storage.objects;
CREATE POLICY fiscal_photo_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'daily-report-fiscal-photos'
  AND (storage.foldername(storage.objects.name))[2] = auth.uid()::text
  AND app_private.fiscal_project_access((storage.foldername(storage.objects.name))[1])
);
DROP POLICY IF EXISTS fiscal_photo_delete ON storage.objects;
CREATE POLICY fiscal_photo_delete ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'daily-report-fiscal-photos'
  AND (storage.foldername(storage.objects.name))[2] = auth.uid()::text
  AND app_private.fiscal_project_access((storage.foldername(storage.objects.name))[1])
  AND NOT EXISTS (
    SELECT 1 FROM public.daily_report_fiscal_notes n
    WHERE n.project_id::text = (storage.foldername(storage.objects.name))[1]
      AND n.photos @> jsonb_build_array(jsonb_build_object('path', storage.objects.name))
  )
);
DROP POLICY IF EXISTS "Org members read daily-report-photos" ON storage.objects;
CREATE POLICY "Org members read daily-report-photos" ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'daily-report-photos' AND (
    app_private.fiscal_project_access((storage.foldername(storage.objects.name))[1])
    OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.is_org_member(auth.uid(), p.organization_id))
  )
);
