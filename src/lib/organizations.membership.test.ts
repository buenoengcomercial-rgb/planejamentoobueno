import { expect, it, vi } from 'vitest';
import { getCurrentMembership } from './organizations';
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getUser: mocks.getUser }, from: mocks.from } }));
it('não converte falha de autenticação em ausência de permissão', async () => {
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'context deadline exceeded', status: 504 } });
  await expect(getCurrentMembership()).rejects.toMatchObject({ status: 504 });
  expect(mocks.from).not.toHaveBeenCalled();
});
