import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import {
  listOrgMembers, inviteMemberByEmail, createMemberWithPassword, updateMemberRole, updateMemberStatus, removeMember,
  OrgMember, OrgRole, MemberStatus, ROLE_LABELS, STATUS_LABELS, canManageMembers,
} from '@/lib/organizations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, ArrowLeft, UserPlus, Trash2, ShieldOff, ShieldCheck, KeyRound, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

const ROLE_OPTIONS: OrgRole[] = ['owner', 'admin', 'engineer', 'field_user', 'viewer'];

export default function TeamManagement() {
  const { user, loading: authLoading } = useAuth();
  const { membership, loading: orgLoading } = useOrganization();
  const navigate = useNavigate();

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('field_user');
  const [submitting, setSubmitting] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createPassword, setCreatePassword] = useState('');

  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdNew, setPwdNew] = useState('');
  const [pwdConfirm, setPwdConfirm] = useState('');
  const [pwdSubmitting, setPwdSubmitting] = useState(false);
  const [resetSubmittingId, setResetSubmittingId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth', { replace: true });
  }, [authLoading, user, navigate]);

  const orgId = membership?.organization.id;
  const myRole = membership?.role;
  const allowed = myRole ? canManageMembers(myRole) : false;

  const reload = async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const list = await listOrgMembers(orgId);
      setMembers(list);
    } catch (e) {
      console.error(e);
      toast.error('Erro ao carregar usuários');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (orgId && allowed) void reload();
    else setLoading(false);
  }, [orgId, allowed]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgId) return;
    setSubmitting(true);
    try {
      if (createMode) {
        const res = await createMemberWithPassword(orgId, inviteEmail, createPassword, inviteRole, createName);
        if (res.ok === true) {
          toast.success('Acesso criado com sucesso.');
          setInviteEmail(''); setCreateName(''); setCreatePassword('');
          void reload();
          return;
        }
        if (res.reason === 'already_member') toast.error('Esta pessoa já é membro da empresa.');
        else toast.error(res.message || 'Erro ao criar acesso.');
        return;
      }
      const res = await inviteMemberByEmail(orgId, inviteEmail, inviteRole);
      if (res.ok === true) {
        toast.success('Usuário liberado.');
        setInviteEmail('');
        void reload();
        return;
      }
      if (res.reason === 'not_registered') {
        toast.error('Este e-mail ainda não tem cadastro. Use "Criar acesso" para cadastrar diretamente.');
      } else if (res.reason === 'already_member') {
        toast.error('Esta pessoa já é membro da empresa.');
      } else {
        toast.error(res.message || 'Erro ao liberar acesso.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoleChange = async (memberId: string, role: OrgRole) => {
    try {
      await updateMemberRole(memberId, role);
      toast.success('Função atualizada');
      void reload();
    } catch { toast.error('Erro ao atualizar função'); }
  };

  const handleStatusChange = async (memberId: string, status: MemberStatus) => {
    try {
      await updateMemberStatus(memberId, status);
      toast.success('Status atualizado');
      void reload();
    } catch { toast.error('Erro ao atualizar status'); }
  };

  const handleRemove = async (memberId: string) => {
    if (!confirm('Remover este usuário da empresa?')) return;
    try {
      await removeMember(memberId);
      toast.success('Usuário removido');
      void reload();
    } catch { toast.error('Erro ao remover'); }
  };

  const handleChangeMyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pwdNew.length < 8) { toast.error('A senha deve ter pelo menos 8 caracteres'); return; }
    if (pwdNew !== pwdConfirm) { toast.error('As senhas não coincidem'); return; }
    setPwdSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password: pwdNew });
    setPwdSubmitting(false);
    if (error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('pwned') || msg.includes('compromis') || msg.includes('weak')) {
        toast.error('Essa senha apareceu em vazamentos. Escolha uma senha diferente.');
      } else {
        toast.error(error.message);
      }
      return;
    }
    toast.success('Senha alterada com sucesso.');
    setPwdOpen(false);
    setPwdNew(''); setPwdConfirm('');
  };

  const handleSendReset = async (member: OrgMember) => {
    if (!member.email) { toast.error('Usuário sem e-mail cadastrado'); return; }
    if (!confirm(`Enviar e-mail de redefinição de senha para ${member.email}?`)) return;
    setResetSubmittingId(member.id);
    const { error } = await supabase.auth.resetPasswordForEmail(member.email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setResetSubmittingId(null);
    if (error) { toast.error(error.message); return; }
    toast.success('E-mail de redefinição enviado.');
  };


  if (authLoading || orgLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-background"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  if (!membership) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <p className="text-sm text-muted-foreground">Você não está vinculado a nenhuma empresa.</p>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6 text-center">
        <div className="space-y-4 max-w-md">
          <h1 className="text-xl font-semibold">Acesso restrito</h1>
          <p className="text-sm text-muted-foreground">Apenas administradores ou proprietários podem gerenciar usuários.</p>
          <Button variant="outline" onClick={() => navigate('/')}>Voltar</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Button variant="ghost" size="sm" onClick={() => navigate('/')} className="mb-2 -ml-2">
              <ArrowLeft className="w-4 h-4 mr-1" /> Voltar
            </Button>
            <h1 className="text-2xl font-bold">Usuários da empresa</h1>
            <p className="text-sm text-muted-foreground">{membership.organization.name}</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base">{createMode ? 'Criar novo acesso' : 'Liberar acesso'}</CardTitle>
                <CardDescription>
                  {createMode
                    ? 'Cadastre uma nova pessoa diretamente: ela já entra ativa na empresa com a senha que você definir.'
                    : 'Adicione uma pessoa que já tem conta no sistema usando o e-mail dela.'}
                </CardDescription>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setCreateMode(v => !v)}>
                {createMode ? 'Liberar existente' : 'Criar acesso novo'}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInvite} className="grid gap-3 md:grid-cols-[1fr_180px_auto] items-end">
              {createMode && (
                <div className="space-y-1 md:col-span-3">
                  <Label htmlFor="create-name">Nome</Label>
                  <Input
                    id="create-name"
                    value={createName}
                    onChange={e => setCreateName(e.target.value)}
                    placeholder="Nome completo"
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="invite-email">E-mail</Label>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  placeholder="usuario@empresa.com"
                />
              </div>
              {createMode && (
                <div className="space-y-1">
                  <Label htmlFor="create-password">Senha</Label>
                  <Input
                    id="create-password"
                    type="password"
                    required
                    minLength={8}
                    value={createPassword}
                    onChange={e => setCreatePassword(e.target.value)}
                    placeholder="Min. 8 caracteres"
                    autoComplete="new-password"
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label>Função</Label>
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as OrgRole)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map(r => (
                      <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={submitting}>
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <><UserPlus className="w-4 h-4 mr-1" /> {createMode ? 'Criar acesso' : 'Liberar'}</>}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Equipe atual</CardTitle></CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            ) : members.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum membro ainda.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Usuário</TableHead>
                    <TableHead>Função</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map(m => {
                    const isMe = m.userId === user?.id;
                    return (
                      <TableRow key={m.id}>
                        <TableCell>
                          <div className="font-medium">{m.name || m.email || m.userId.slice(0, 8)}</div>
                          <div className="text-xs text-muted-foreground">{m.email}</div>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={m.role}
                            onValueChange={(v) => handleRoleChange(m.id, v as OrgRole)}
                            disabled={isMe}
                          >
                            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {ROLE_OPTIONS.map(r => (
                                <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Badge variant={m.status === 'active' ? 'default' : m.status === 'blocked' ? 'destructive' : 'secondary'}>
                            {STATUS_LABELS[m.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right space-x-1">
                          {isMe ? (
                            <Button size="sm" variant="outline" onClick={() => { setPwdNew(''); setPwdConfirm(''); setPwdOpen(true); }}>
                              <KeyRound className="w-3.5 h-3.5 mr-1" /> Alterar minha senha
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleSendReset(m)}
                              disabled={!m.email || resetSubmittingId === m.id}
                            >
                              {resetSubmittingId === m.id
                                ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                                : <Mail className="w-3.5 h-3.5 mr-1" />}
                              Enviar redefinição
                            </Button>
                          )}
                          {m.status === 'blocked' ? (
                            <Button size="sm" variant="outline" onClick={() => handleStatusChange(m.id, 'active')} disabled={isMe}>
                              <ShieldCheck className="w-3.5 h-3.5 mr-1" /> Reativar
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => handleStatusChange(m.id, 'blocked')} disabled={isMe}>
                              <ShieldOff className="w-3.5 h-3.5 mr-1" /> Bloquear
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => handleRemove(m.id)} disabled={isMe} className="text-destructive">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={pwdOpen} onOpenChange={setPwdOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Alterar minha senha</DialogTitle>
            <DialogDescription>Defina uma nova senha forte (mínimo 8 caracteres).</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleChangeMyPassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pwd-new">Nova senha</Label>
              <Input id="pwd-new" type="password" required minLength={8} value={pwdNew} onChange={e => setPwdNew(e.target.value)} autoComplete="new-password" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pwd-confirm">Confirmar nova senha</Label>
              <Input id="pwd-confirm" type="password" required minLength={8} value={pwdConfirm} onChange={e => setPwdConfirm(e.target.value)} autoComplete="new-password" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPwdOpen(false)}>Cancelar</Button>
              <Button type="submit" disabled={pwdSubmitting}>
                {pwdSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Salvar nova senha'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
