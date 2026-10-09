/**
 * Trilha de auditoria do projeto.
 *
 * Toda ação importante (Medição, Aditivo, Diário, Tarefas) deve gerar um
 * AuditLog. Os logs ficam embutidos no Project (project.auditLogs) e são
 * persistidos junto com o restante do estado.
 */
import type {
  AuditAction,
  AuditEntityType,
  AuditLog,
  Project,
} from '@/types/project';

export interface AuditUserInfo {
  userId?: string;
  userName?: string;
  userEmail?: string;
}

export interface CreateAuditLogParams extends AuditUserInfo {
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  title: string;
  description?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Gera um AuditLog com id único e data atual. */
export function createAuditLog(params: CreateAuditLogParams): AuditLog {
  const { userId, userName, userEmail, ...rest } = params;
  return {
    id: genId(),
    at: new Date().toISOString(),
    userId,
    userName: userName || userEmail || undefined,
    userEmail,
    ...rest,
  };
}

/** Retorna o projeto com o log adicionado ao final. */
export function appendAuditLog(project: Project, log: AuditLog): Project {
  const current = project.auditLogs ?? [];
  const next = [...current, log];
  return { ...project, auditLogs: next };
}

/** Atalho: cria + anexa em uma chamada. */
export function logToProject(project: Project, params: CreateAuditLogParams): Project {
  return appendAuditLog(project, createAuditLog(params));
}

/** Retorna logs filtrados por entidade. */
export function getEntityAuditLogs(
  project: Project,
  entityType: AuditEntityType,
  entityId: string,
): AuditLog[] {
  const logs = project.auditLogs ?? [];
  return logs
    .filter(l => l.entityType === entityType && l.entityId === entityId)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Resumo de uma lista de logs (contadores por ação). */
export function summarizeAuditLogs(logs: AuditLog[]) {
  const byAction: Record<AuditAction, number> = {
    created: 0,
    updated: 0,
    submitted_for_review: 0,
    approved: 0,
    rejected: 0,
    contracted: 0,
    unlocked: 0,
    deleted: 0,
    imported: 0,
    exported: 0,
  };
  for (const l of logs) {
    if (l.action in byAction) byAction[l.action] += 1;
  }
  return {
    total: logs.length,
    byAction,
    lastAt: logs.reduce<string | undefined>(
      (acc, l) => (!acc || l.at > acc ? l.at : acc),
      undefined,
    ),
  };
}

// =================================================================
// Helpers de identidade do usuário (para uso em componentes React).
// =================================================================
import type { User } from '@supabase/supabase-js';

/** Extrai informações de auditoria a partir do usuário Supabase logado. */
export function userInfoFromSupabaseUser(user: User | null | undefined): AuditUserInfo {
  if (!user) return {};
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof meta.name === 'string' && meta.name) ||
    (typeof meta.full_name === 'string' && meta.full_name) ||
    undefined;
  return {
    userId: user.id,
    userEmail: user.email ?? undefined,
    userName: name || user.email || undefined,
  };
}

// =================================================================
// Rótulos para exibição na UI (Histórico).
// =================================================================
export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  created: 'Criado',
  updated: 'Atualizado',
  submitted_for_review: 'Enviado para análise',
  approved: 'Aprovado',
  rejected: 'Reprovado',
  contracted: 'Contratado',
  unlocked: 'Destravado',
  deleted: 'Excluído',
  imported: 'Importado',
  exported: 'Exportado',
};

export const AUDIT_ACTION_BADGE: Record<AuditAction, string> = {
  created: 'bg-slate-100 text-slate-700 border-slate-300',
  updated: 'bg-blue-100 text-blue-800 border-blue-300',
  submitted_for_review: 'bg-amber-100 text-amber-800 border-amber-300',
  approved: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  rejected: 'bg-rose-100 text-rose-800 border-rose-300',
  contracted: 'bg-primary/15 text-primary border-primary/40',
  unlocked: 'bg-violet-100 text-violet-800 border-violet-300',
  deleted: 'bg-rose-100 text-rose-800 border-rose-300',
  imported: 'bg-indigo-100 text-indigo-800 border-indigo-300',
  exported: 'bg-cyan-100 text-cyan-800 border-cyan-300',
};
