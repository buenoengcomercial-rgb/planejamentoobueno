import { expect, it } from 'vitest';
import { warehouseEditBaseline } from './warehouseEditBaseline';
import { emptyWarehouse } from './warehouse';
import { mergeConcurrentFields } from './concurrentFields';
import type { Project } from '@/types/project';
const original = { id: 'p', warehouse: { ...emptyWarehouse(), equipments: [
  { id: 'a', name: 'A', notes: 'Antes' }, { id: 'b', name: 'B' },
] } } as Project;
it('mantém base de formulário mesmo após receber outro valor e exclui registros remotos do envio', () => {
  const current = { ...original, warehouse: { ...original.warehouse!, equipments: [
    { ...original.warehouse!.equipments[0], notes: 'Primeiro' }, { ...original.warehouse!.equipments[1], name: 'Remoto' },
  ] } };
  const next = { ...current, warehouse: { ...current.warehouse, equipments: [
    { ...original.warehouse!.equipments[0], notes: 'Segundo' }, current.warehouse.equipments[1],
  ] } };
  const base = warehouseEditBaseline(original, current, next);
  expect(base.warehouse!.equipments[0].notes).toBe('Antes');
  expect(base.warehouse!.equipments[1]).toBe(current.warehouse.equipments[1]);
  const merged = mergeConcurrentFields(base.warehouse, next.warehouse, current.warehouse);
  expect(merged.conflicts).toEqual(['/equipments/a/notes']);
  expect(merged.value!.equipments[0].notes).toBe('Primeiro');
});
it('formulário antigo não recria registro removido remotamente', () => {
  const current = { ...original, warehouse: { ...original.warehouse!, equipments: [original.warehouse!.equipments[1]] } };
  const next = { ...original, warehouse: { ...original.warehouse!, equipments: [
    { ...original.warehouse!.equipments[0], notes: 'Edição' }, original.warehouse!.equipments[1],
  ] } };
  const base = warehouseEditBaseline(original, current, next);
  const merged = mergeConcurrentFields(base.warehouse, next.warehouse, current.warehouse);
  expect(merged.conflicts).toContain('/equipments/a');
  expect(merged.value!.equipments.map(row => row.id)).toEqual(['b']);
});
