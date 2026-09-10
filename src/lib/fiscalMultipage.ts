import type { WarehouseFiscalExtractionPage, WarehouseFiscalNote } from '@/types/project';

const CENT_TOLERANCE = 0.01;

export function fiscalItemsSubtotal(note: Pick<WarehouseFiscalNote, 'items'>): number {
  return note.items.reduce((total, item) => total + Number(item.totalPrice || 0), 0);
}

export function fiscalExpectedProductsAmount(note: Pick<WarehouseFiscalNote, 'totalAmount' | 'productsAmount'>): number {
  const productsAmount = Number(note.productsAmount || 0);
  return productsAmount > 0 ? productsAmount : Number(note.totalAmount || 0);
}

export interface FiscalReadingCheck {
  pages: WarehouseFiscalExtractionPage[];
  itemsSubtotal: number;
  expectedProductsAmount: number;
  invalidItemCount: number;
  unreadPageCount: number;
  difference: number;
  canPost: boolean;
  reason?: string;
}

export function fiscalReadingCheck(note: Pick<WarehouseFiscalNote, 'items' | 'totalAmount' | 'productsAmount' | 'extractionPages' | 'extractionStatus' | 'processingError'>): FiscalReadingCheck {
  const pages = note.extractionPages ?? [];
  const itemsSubtotal = fiscalItemsSubtotal(note);
  const expectedProductsAmount = fiscalExpectedProductsAmount(note);
  const positive = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0;
  const invalidItemCount = note.items.filter(item => !item.description?.trim() || !positive(item.quantity) || !positive(item.totalPrice)).length;
  const expectedPageCount = Math.max(pages.length, ...pages.map(page => Number(page.totalPages) || 0));
  const missingPageCount = Math.max(0, expectedPageCount - pages.length);
  const unreadPageCount = pages.filter(page => page.status !== 'ready').length + missingPageCount;
  const difference = Math.abs(Math.round(itemsSubtotal * 100) - Math.round(expectedProductsAmount * 100)) / 100;
  const pending = (reason: string): FiscalReadingCheck => ({ pages, itemsSubtotal, expectedProductsAmount, invalidItemCount, unreadPageCount, difference, canPost: false, reason });

  if (!pages.length) return pending('Nenhuma página foi lida. Repita a leitura do documento.');
  if (unreadPageCount > 0) return { pages, itemsSubtotal, expectedProductsAmount, invalidItemCount, unreadPageCount, difference, canPost: false, reason: `${unreadPageCount} página(s) não foram lidas.` };
  if (note.extractionStatus === 'failed' || note.extractionStatus === 'reading' || note.processingError) return pending('A leitura não foi concluída. Repita a leitura antes de lançar.');
  const printedNumbers = pages.map(page => page.pageNumber).filter((number): number is number => number != null);
  if (new Set(pages.map(page => page.sourceIndex)).size !== pages.length || new Set(printedNumbers).size !== printedNumbers.length) return pending('Há páginas repetidas. Confira os anexos e repita a leitura.');
  if (!note.items.length) return pending('Nenhum item identificado. Confira as páginas e os itens do documento.');
  if (invalidItemCount > 0) return { pages, itemsSubtotal, expectedProductsAmount, invalidItemCount, unreadPageCount, difference, canPost: false, reason: `${invalidItemCount} item(ns) sem quantidade ou valor válido.` };
  if (!positive(expectedProductsAmount)) return pending('Informe o valor dos produtos esperado para conferir os itens.');
  if (expectedProductsAmount > 0 && difference > CENT_TOLERANCE) return { pages, itemsSubtotal, expectedProductsAmount, invalidItemCount, unreadPageCount, difference, canPost: false, reason: 'A soma dos itens diverge do valor dos produtos da NF.' };
  return { pages, itemsSubtotal, expectedProductsAmount, invalidItemCount, unreadPageCount, difference, canPost: true };
}
