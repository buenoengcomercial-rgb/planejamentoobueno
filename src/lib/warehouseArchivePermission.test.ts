import { describe, expect, it } from 'vitest';
import { canArchiveWarehouseRecords } from './warehouseArchivePermission';

describe('warehouse archive permission', () => {
  it('hides archive from the warehouse operator who the server rejects', () => {
    expect(canArchiveWarehouseRecords('warehouse_operator', true)).toBe(false);
  });

  it('keeps archive for authorized editors and blocks viewers', () => {
    expect(canArchiveWarehouseRecords('owner', true)).toBe(true);
    expect(canArchiveWarehouseRecords('admin', true)).toBe(true);
    expect(canArchiveWarehouseRecords('engineer', true)).toBe(true);
    expect(canArchiveWarehouseRecords('owner', false)).toBe(false);
  });
});
