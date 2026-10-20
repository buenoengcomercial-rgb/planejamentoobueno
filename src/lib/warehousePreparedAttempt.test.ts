import { expect, it, vi } from 'vitest';
import { WarehousePreparedAttempt } from './warehousePreparedAttempt';

it('preserva conteúdo, identificadores e horários após resposta perdida e clique duplo', async () => {
  const runner = new WarehousePreparedAttempt<object, string>();
  const prepare = vi.fn(async () => ({ id: crypto.randomUUID(), at: new Date().toISOString() }));
  const send = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue('confirmed');
  await expect(runner.run('first', prepare, send)).rejects.toThrow('Failed to fetch');
  const [first, second] = await Promise.all([runner.run('first', prepare, send), runner.run('first', prepare, send)]);
  expect(first).toEqual(second);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0][0]).toBe(send.mock.calls[1][0]);
});
it('resolve primeiro a tentativa incerta quando o rascunho mudou', async () => {
  const runner = new WarehousePreparedAttempt<string, string>();
  const send = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue('saved');
  await expect(runner.run('old', async () => 'old-payload', send)).rejects.toThrow();
  expect(await runner.run('new', async () => 'new-payload', send)).toEqual({ result: 'saved', previousDraft: true });
  expect(send.mock.calls[1][0]).toBe('old-payload');
  await runner.run('new', async () => 'new-payload', send);
  expect(send.mock.calls[2][0]).toBe('new-payload');
});
it('prepara nova identificação somente depois de recusa definitiva', async () => {
  const runner = new WarehousePreparedAttempt<string, string>();
  const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Refused'), { definitiveRejection: true })).mockResolvedValue('ok');
  await expect(runner.run('old', async () => 'id-1', send)).rejects.toThrow('Refused');
  await runner.run('corrected', async () => 'id-2', send);
  expect(send.mock.calls.map(call => call[0])).toEqual(['id-1', 'id-2']);
});
