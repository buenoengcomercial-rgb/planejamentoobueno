import type { WarehouseFiscalNoteItem } from '@/types/project';

// DANFE 013758, photos image (17).jpg (7 rows) and image (16).jpg (23 rows).
export const indikaItems: WarehouseFiscalNoteItem[] = [
  194, 116, 88, 116, 364, 417, 364,
  145, 17, 145, 172, 5, 4, 160, 160, 9, 39, 9, 33, 33, 33, 33, 21, 21, 8, 10, 10, 10, 11, 2,
].map((quantity, index) => ({
  id: `esp-pvc-${index + 1}`, productCode: `ESP PVC${index + 1}`,
  description: `Placa personalizada fotoluminescente PVC - ESP PVC${index + 1}`,
  sourcePageIndex: index < 7 ? 0 : 1,
  quantity, unit: 'UN', unitPrice: 7.5, totalPrice: quantity * 7.5,
}));
