-- Permite que Proprietário e Administrador leiam o nome dos membros da própria
-- organização na gestão de usuários. Cada usuário continua podendo ler seu perfil.
CREATE POLICY "profiles_select_org_managers"
ON public.profiles
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.organization_members AS manager
    JOIN public.organization_members AS target
      ON target.organization_id = manager.organization_id
    WHERE manager.user_id = auth.uid()
      AND manager.status = 'active'
      AND manager.role IN ('owner', 'admin')
      AND target.user_id = profiles.user_id
  )
);