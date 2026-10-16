import { expect, it, vi } from 'vitest';
import { getCurrentMembership, updateMemberRole, updateMemberStatus } from './organizations';
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getUser: mocks.getUser }, from: mocks.from } }));
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
