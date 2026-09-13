import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('fronteiras do pré-carregamento ocioso', () => {
  it('prepara somente a próxima jornada permitida no núcleo autenticado', () => {
    const index = source('src/pages/Index.tsx');
    const policy = index.match(/const NEXT_VIEW_PRELOAD[\s\S]*?\n};/)?.[0] ?? '';

    expect(index).toContain('scheduleIdlePreload(candidate.load)');
    expect(index).toContain('canAccessAppView(role, candidate.view)');
    expect(policy).toContain("dashboard: { view: 'management'");
    expect(policy).toContain("materials: { view: 'warehouse'");
    expect(policy).not.toMatch(/jspdf|xlsx|pdfjs|ImportSyntheticDialog/);
  });

  it('prepara uma única subaba operacional sem antecipar documentos', () => {
    const warehouse = source('src/components/warehouse/Warehouse.tsx');
    const policy = warehouse.match(/const NEXT_WAREHOUSE_TAB_PRELOAD[\s\S]*?\n};/)?.[0] ?? '';

    expect(warehouse).toContain('scheduleIdlePreload(NEXT_WAREHOUSE_TAB_PRELOAD[tab])');
    expect(policy).toContain('painel: loadWarehouseRequisitionsTab');
    expect(policy).not.toMatch(/pdf|xlsx|AttachmentOptimization|GlobalStorage/);
  });
});
