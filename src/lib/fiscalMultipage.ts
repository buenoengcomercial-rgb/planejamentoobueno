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

export function fiscalReadingCheck(note: Pick<WarehouseFiscalNote, 'items' | 'totalAmount' | 'productsAmount' | 'extractionPages'>): FiscalReadingCheck {
  const pages = note.extractionPages ?? [];
  const itemsSubtotal = fiscalItemsSubtotal(note);
  const expectedProductsAmount = fiscalExpectedProductsAmount(note);
  const invalidItemCount = note.items.filter(item => !item.description.trim() || Number(item.quantity || 0) <= 0 || Number(item.totalPrice || 0) <= 0).length;
  const unreadPageCount = pages.filter(page => page.status !== 'ready').length;
  const difference = Math.abs(itemsSubtotal - expectedProductsAmount);

  if (unreadPageCount > 0) return { pages, itemsSubtotal, expectedProductsAmount, invalidItemCount, unreadPageCount, difference, canPost: false, reason: `${unreadPageCount} página(s) não foram lidas.` };
  if (invalidItemCount > 0) return { pages, itemsSubtotal, expectedProductsAmount, invalidItemCount, unreadPageCount, difference, canPost: false, reason: `${invalidItemCount} item(ns) sem quantidade ou valor válido.` };
  if (expectedProductsAmount > 0 && difference > CENT_TOLERANCE) return { pages, itemsSubtotal, expectedProductsAmount, invalidItemCount, unreadPageCount, difference, canPost: false, reason: 'A soma dos itens diverge do valor dos produtos da NF.' };
  return { pages, itemsSubtotal, expectedProductsAmount, invalidItemCount, unreadPageCount, difference, canPost: true };
}
