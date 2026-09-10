import { describe, expect, it } from 'vitest';
import type { WarehouseFiscalNoteItem } from '@/types/project';
import { fiscalReadingCheck } from './fiscalMultipage';

const indikaItems: WarehouseFiscalNoteItem[] = Array.from({ length: 30 }, (_, index) => ({
  id: `esp-pvc-${index + 1}`,
  productCode: `ESP PVC${index + 1}`,
  description: `Placa personalizada fotoluminescente PVC ${index + 1}`,
  quantity: 1,
  unit: 'UN',
  unitPrice: 687.25,
  totalPrice: 687.25,
}));

describe('fiscalReadingCheck', () => {
  it('libera a NF Indika de duas páginas quando os 30 itens fecham R$ 20.617,50', () => {
    const check = fiscalReadingCheck({
      items: indikaItems,
      totalAmount: 20_617.5,
      productsAmount: 20_617.5,
      extractionPages: [
        { sourceIndex: 1, pageNumber: 2, totalPages: 2, itemCount: 23, confidence: 0.96, status: 'ready' },
        { sourceIndex: 0, pageNumber: 1, totalPages: 2, itemCount: 7, confidence: 0.98, status: 'ready' },
      ],
    });

    expect(check.canPost).toBe(true);
    expect(check.itemsSubtotal).toBe(20_617.5);
    expect(check.pages.map(page => page.pageNumber)).toEqual([2, 1]);
  });

  it('bloqueia quando a segunda página é omitida e o subtotal fica em R$ 12.442,50', () => {
    const check = fiscalReadingCheck({
      items: Array.from({ length: 7 }, (_, index) => ({ ...indikaItems[index], totalPrice: 12_442.5 / 7 })),
      totalAmount: 20_617.5,
      productsAmount: 20_617.5,
      extractionPages: [
        { sourceIndex: 0, pageNumber: 1, totalPages: 2, itemCount: 7, status: 'ready' },
        { sourceIndex: 1, pageNumber: 2, totalPages: 2, itemCount: 0, status: 'failed', error: 'Página não lida' },
      ],
    });

    expect(check.canPost).toBe(false);
    expect(check.unreadPageCount).toBe(1);
    expect(check.reason).toContain('não foram lidas');
  });

  it('usa o valor dos produtos, sem bloquear uma nota cujo total inclui frete ou desconto', () => {
    const check = fiscalReadingCheck({
      items: [{ ...indikaItems[0], totalPrice: 100 }],
      totalAmount: 115,
      productsAmount: 100,
      extractionPages: [{ sourceIndex: 0, itemCount: 1, status: 'ready' }],
    });

    expect(check.canPost).toBe(true);
    expect(check.expectedProductsAmount).toBe(100);
  });
});
