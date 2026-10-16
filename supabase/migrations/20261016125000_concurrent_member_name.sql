-- The same owner/admin authority as admin-update-member-name, with one
-- transaction for the display profile and the name used in future audits.
CREATE FUNCTION public.update_member_name_v2(p_organization_id uuid,p_user_id uuid,p_expected_name text,p_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE prior_name text; clean_name text:=btrim(p_name); target auth.users;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),p_organization_id,ARRAY['owner','admin']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Sem permissão para atualizar usuários desta empresa' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.organization_members WHERE organization_id=p_organization_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Usuário não pertence a esta empresa' USING ERRCODE='42501'; END IF;
  IF clean_name IS NULL OR clean_name='' OR length(clean_name)>120 THEN RAISE EXCEPTION 'Nome inválido' USING ERRCODE='22023'; END IF;
  SELECT * INTO target FROM auth.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Usuário não encontrado'; END IF;
  SELECT name INTO prior_name FROM public.profiles WHERE user_id=p_user_id FOR UPDATE;
  IF prior_name IS DISTINCT FROM p_expected_name AND prior_name IS DISTINCT FROM clean_name THEN
    RAISE EXCEPTION 'O nome mudou. Foi mantida a primeira confirmação; sua tentativa continua no campo.' USING ERRCODE='P0002';
  END IF;
  UPDATE auth.users SET raw_user_meta_data=coalesce(raw_user_meta_data,'{}'::jsonb)||jsonb_build_object('name',clean_name)
    WHERE id=p_user_id;
  INSERT INTO public.profiles(user_id,name,email) VALUES(p_user_id,clean_name,target.email)
    ON CONFLICT(user_id) DO UPDATE SET name=excluded.name;
  RETURN jsonb_build_object('ok',true,'name',clean_name);
END; $$;
REVOKE ALL ON FUNCTION public.update_member_name_v2(uuid,uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_member_name_v2(uuid,uuid,text,text) TO authenticated;
