import { expect, it, vi } from 'vitest';
import { getCurrentMembership, updateMemberName, updateMemberRole, updateMemberStatus } from './organizations';
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getUser: mocks.getUser }, from: mocks.from, rpc: mocks.rpc } }));
it('nome envia a base do campo e mantém o erro de colisão', async () => {
  mocks.rpc.mockResolvedValue({error:{message:'Primeira confirmação preservada'}});
  await expect(updateMemberName('org','user','Tentativa','Antes')).rejects.toThrow('preservada');
  expect(mocks.rpc).toHaveBeenCalledWith('update_member_name_v2',{p_organization_id:'org',p_user_id:'user',p_name:'Tentativa',p_expected_name:'Antes'});
});
it('não converte falha de autenticação em ausência de permissão', async () => {
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'context deadline exceeded', status: 504 } });
  await expect(getCurrentMembership()).rejects.toMatchObject({ status: 504 });
  expect(mocks.from).not.toHaveBeenCalled();
});
it('compara o campo anterior e não confirma alteração administrativa sem linha afetada', async () => {
  const query={update:vi.fn(),eq:vi.fn(),select:vi.fn(),maybeSingle:vi.fn().mockResolvedValue({data:null,error:null})};
  for(const fn of [query.update,query.eq,query.select]) fn.mockReturnValue(query);
  mocks.from.mockReturnValue(query);
  await expect(updateMemberRole('member','engineer','viewer')).rejects.toThrow('primeira');
  expect(query.eq).toHaveBeenCalledWith('role','viewer');
  query.maybeSingle.mockResolvedValue({data:{id:'member'},error:null});
  await expect(updateMemberStatus('member','blocked','active')).resolves.toBeUndefined();
  expect(query.eq).toHaveBeenCalledWith('status','active');
});
