import type { OrgRole } from '@/lib/organizations';

/** Align the archive action with the warehouse operator restriction enforced in the database. */
export function canArchiveWarehouseRecords(role: OrgRole | undefined, warehouseEditor: boolean): boolean {
  return warehouseEditor && role !== 'warehouse_operator';
}
