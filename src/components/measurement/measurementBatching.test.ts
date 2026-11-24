import { expect, it } from 'vitest';
import { CLOUD_DETAIL_IDLE_MS, CLOUD_DETAIL_MAX_WAIT_MS } from './measurementBatching';

it('mantém o lote da Medição aberto por 30 s entre linhas sem envio automático', () => {
  expect(CLOUD_DETAIL_IDLE_MS).toBeGreaterThan(30_000);
  expect(CLOUD_DETAIL_MAX_WAIT_MS).toBeGreaterThan(30_000);
});
