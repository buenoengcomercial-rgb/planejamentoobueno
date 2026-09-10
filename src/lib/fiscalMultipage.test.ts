import { describe, expect, it } from 'vitest';
import { indikaItems } from '@/test/fixtures/indikaFiscalNote';
import { fiscalReadingCheck } from './fiscalMultipage';

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
      items: indikaItems.slice(0, 7),
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
    expect(check.itemsSubtotal).toBe(12_442.5);
  });

  it('nunca confere zero contra zero após erro da função ou resposta vazia', () => {
    expect(fiscalReadingCheck({ items: [], totalAmount: 0, extractionStatus: 'failed' }).canPost).toBe(false);
    expect(fiscalReadingCheck({ items: [], totalAmount: 0, extractionPages: [{ sourceIndex: 0, itemCount: 0, status: 'ready' }] }).canPost).toBe(false);
  });

  it('bloqueia página omitida mesmo que a soma feche e só uma página retorne', () => {
    const check = fiscalReadingCheck({ items: indikaItems, totalAmount: 20_617.5,
      extractionPages: [{ sourceIndex: 0, pageNumber: 1, totalPages: 2, itemCount: 7, status: 'ready' }],
    });
    expect(check.canPost).toBe(false);
    expect(check.unreadPageCount).toBe(1);
  });

  it.each([0, NaN, Infinity, -1])('bloqueia quantidade inválida %s', quantity => {
    expect(fiscalReadingCheck({ items: [{ ...indikaItems[0], quantity }], totalAmount: indikaItems[0].totalPrice,
      extractionPages: [{ sourceIndex: 0, itemCount: 1, status: 'ready' }],
    }).canPost).toBe(false);
  });

  it('compara a tolerância exata de um centavo sem erro binário', () => {
    const note = { items: [{ ...indikaItems[0], totalPrice: 100 }], totalAmount: 100.01,
      extractionPages: [{ sourceIndex: 0, itemCount: 1, status: 'ready' as const }],
    };
    expect(fiscalReadingCheck(note).canPost).toBe(true);
    expect(fiscalReadingCheck({ ...note, totalAmount: 100.02 }).canPost).toBe(false);
    expect(fiscalReadingCheck({ ...note, totalAmount: 0 }).canPost).toBe(false);
    expect(fiscalReadingCheck({ ...note, extractionStatus: 'failed' }).canPost).toBe(false);
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
