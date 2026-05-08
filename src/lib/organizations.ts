import { supabase } from '@/integrations/supabase/client';

export type OrgRole = 'owner' | 'admin' | 'engineer' | 'field_user' | 'viewer';
export type MemberStatus = 'active' | 'invited' | 'blocked';

export interface Organization {
  id: string;
  name: string;
  cnpj: string | null;
}

export interface OrgMembership {
  organization: Organization;
  role: OrgRole;
  status: MemberStatus;
}

export interface OrgMember {
  id: string;
  organizationId: string;
  userId: string;
  role: OrgRole;
  status: MemberStatus;
  invitedEmail: string | null;
  createdAt: string;
  /** Filled-in display fields (best-effort) */
  email?: string | null;
  name?: string | null;
}

/** Permissões de alto nível derivadas da role. */
export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Proprietário',
  admin: 'Administrador',
  engineer: 'Engenheiro',
  field_user: 'Equipe de campo',
  viewer: 'Visualizador',
};

export const STATUS_LABELS: Record<MemberStatus, string> = {
  active: 'Ativo',
  invited: 'Convidado',
  blocked: 'Bloqueado',
};

export function canManageMembers(role: OrgRole): boolean {
  return role === 'owner' || role === 'admin';
}
export function canCreateProject(role: OrgRole): boolean {
  return role === 'owner' || role === 'admin';
}
export function canEditProject(role: OrgRole): boolean {
  return role === 'owner' || role === 'admin' || role === 'engineer';
}
export function canDeleteProject(role: OrgRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** Carrega a primeira organização ativa do usuário autenticado. */
export async function getCurrentMembership(): Promise<OrgMembership | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('organization_members')
    .select('role, status, organization_id, organizations:organization_id ( id, name, cnpj )')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data || !data.organizations) return null;
  // organizations may come back as object or array depending on relation; normalize
  const org = Array.isArray(data.organizations) ? data.organizations[0] : data.organizations;
  if (!org) return null;
  return {
    organization: { id: org.id, name: org.name, cnpj: org.cnpj ?? null },
    role: data.role as OrgRole,
    status: data.status as MemberStatus,
  };
}

/** Lista todos os membros (qualquer status) da organização. */
export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const { data, error } = await supabase
    .from('organization_members')
    .select('id, organization_id, user_id, role, status, invited_email, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const userIds = Array.from(new Set((data ?? []).map(r => r.user_id)));
  let profiles: Record<string, { name: string | null; email: string | null }> = {};
  if (userIds.length > 0) {
    const { data: profs } = await supabase
      .from('profiles')
      .select('user_id, name, email')
      .in('user_id', userIds);
    profiles = Object.fromEntries((profs ?? []).map(p => [p.user_id, { name: p.name, email: p.email }]));
  }

  return (data ?? []).map(r => ({
    id: r.id,
    organizationId: r.organization_id,
    userId: r.user_id,
    role: r.role as OrgRole,
    status: r.status as MemberStatus,
    invitedEmail: r.invited_email,
    createdAt: r.created_at,
    email: profiles[r.user_id]?.email ?? r.invited_email ?? null,
    name: profiles[r.user_id]?.name ?? null,
  }));
}

/**
 * Convida um usuário existente por e-mail.
 * Procura o profile pelo e-mail e cria o vínculo ativo. Caso o e-mail ainda não tenha
 * conta cadastrada, a inserção será rejeitada (precisa criar conta primeiro).
 */
export async function inviteMemberByEmail(
  orgId: string,
  email: string,
  role: OrgRole
): Promise<{ ok: true } | { ok: false; reason: 'not_registered' | 'already_member' | 'error'; message?: string }> {
  const cleanEmail = email.trim().toLowerCase();
  const { data: prof, error: profErr } = await supabase
    .from('profiles')
    .select('user_id')
    .ilike('email', cleanEmail)
    .maybeSingle();
  if (profErr) return { ok: false, reason: 'error', message: profErr.message };
  if (!prof) return { ok: false, reason: 'not_registered' };

  const { error } = await supabase
    .from('organization_members')
    .insert([{
      organization_id: orgId,
      user_id: prof.user_id,
      role,
      status: 'active',
      invited_email: cleanEmail,
    }]);
  if (error) {
    if (error.code === '23505') return { ok: false, reason: 'already_member' };
    return { ok: false, reason: 'error', message: error.message };
  }
  return { ok: true };
}

/**
 * Cria diretamente um novo usuário (auth + profile + membership ativa) na organização.
 * Requer que quem chama seja owner/admin. Usa a edge function admin-create-member.
 */
export async function createMemberWithPassword(
  orgId: string,
  email: string,
  password: string,
  role: OrgRole,
  name?: string,
): Promise<{ ok: true } | { ok: false; reason: 'already_member' | 'error'; message?: string }> {
  const { data, error } = await supabase.functions.invoke('admin-create-member', {
    body: {
      organization_id: orgId,
      email: email.trim().toLowerCase(),
      password,
      role,
      name: name?.trim() || null,
    },
  });
  if (error) {
    const msg = (data as any)?.error || error.message;
    if (msg === 'already_member') return { ok: false, reason: 'already_member' };
    return { ok: false, reason: 'error', message: msg };
  }
  if (data && (data as any).ok) return { ok: true };
  return { ok: false, reason: 'error', message: (data as any)?.error };
}

export async function updateMemberRole(memberId: string, role: OrgRole): Promise<void> {
  const { error } = await supabase
    .from('organization_members')
    .update({ role })
    .eq('id', memberId);
  if (error) throw error;
}

export async function updateMemberStatus(memberId: string, status: MemberStatus): Promise<void> {
  const { error } = await supabase
    .from('organization_members')
    .update({ status })
    .eq('id', memberId);
  if (error) throw error;
}

export async function removeMember(memberId: string): Promise<void> {
  const { error } = await supabase
    .from('organization_members')
    .delete()
    .eq('id', memberId);
  if (error) throw error;
}
