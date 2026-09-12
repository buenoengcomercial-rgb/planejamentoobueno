import { describe, expect, it } from 'vitest';
import { normalizedDeletePolicy } from '@/lib/projectSync';

describe('proteção contra exclusão por snapshot desatualizado', () => {
  it('nunca interpreta ausência local como exclusão de requisição, Diário ou auditoria', () => {
    expect(normalizedDeletePolicy('warehouse_requisitions', {})).toBe(false);
    expect(normalizedDeletePolicy('daily_reports', {})).toBe(false);
    expect(normalizedDeletePolicy('audit_logs', {})).toBe(false);
  });

  it('protege movimentos de retirada e devolução, preservando ajustes administrativos independentes', () => {
    expect(normalizedDeletePolicy('warehouse_movements', { originType: 'withdrawal' })).toBe(false);
    expect(normalizedDeletePolicy('warehouse_movements', { originType: 'return' })).toBe(false);
    expect(normalizedDeletePolicy('warehouse_movements', { originType: 'inventory' })).toBe(true);
  });
});
