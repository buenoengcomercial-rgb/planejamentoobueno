-- Garante bootstrap de acesso em banco novo: o primeiro usuario vira owner.

CREATE OR REPLACE FUNCTION app_private.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_default_org_id uuid := '00000000-0000-0000-0000-000000000001'::uuid;
BEGIN
  INSERT INTO public.profiles (user_id, name, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.email),
    NEW.email
  )
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.organizations (id, name, cnpj)
  VALUES (v_default_org_id, 'K. C. BUENO DE GODOY OLIVEIRA LTDA', '39.973.085/0001-20')
  ON CONFLICT (id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE status = 'active'
  ) THEN
    INSERT INTO public.organization_members (
      organization_id,
      user_id,
      role,
      status,
      invited_email
    )
    VALUES (
      v_default_org_id,
      NEW.id,
      'owner'::public.org_role,
      'active'::public.member_status,
      NEW.email
    )
    ON CONFLICT (organization_id, user_id)
    DO UPDATE SET
      role = 'owner'::public.org_role,
      status = 'active'::public.member_status,
      invited_email = EXCLUDED.invited_email,
      updated_at = now();
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.handle_new_user() FROM PUBLIC;

DO $$
DECLARE
  v_default_org_id uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_user record;
BEGIN
  INSERT INTO public.organizations (id, name, cnpj)
  VALUES (v_default_org_id, 'K. C. BUENO DE GODOY OLIVEIRA LTDA', '39.973.085/0001-20')
  ON CONFLICT (id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE status = 'active'
  ) THEN
    SELECT id, email
    INTO v_user
    FROM auth.users
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_user.id IS NOT NULL THEN
      INSERT INTO public.organization_members (
        organization_id,
        user_id,
        role,
        status,
        invited_email
      )
      VALUES (
        v_default_org_id,
        v_user.id,
        'owner'::public.org_role,
        'active'::public.member_status,
        v_user.email
      )
      ON CONFLICT (organization_id, user_id)
      DO UPDATE SET
        role = 'owner'::public.org_role,
        status = 'active'::public.member_status,
        invited_email = EXCLUDED.invited_email,
        updated_at = now();
    END IF;
  END IF;
END;
$$;
