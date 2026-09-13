import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('fronteiras sob demanda de PDF e Excel', () => {
  it('mantém o importador pesado fora do carregamento inicial da Produção', () => {
    const taskList = source('src/components/TaskList.tsx');

    expect(taskList).not.toMatch(/import\s+ImportSyntheticDialog\s+from/);
    expect(taskList).toContain("lazyWithReload(() => import('@/components/ImportSyntheticDialog'))");
    expect(taskList).toMatch(/importSyntheticOpen\s*\?\s*\(/);
  });

  it('mantém os motores de documentos atrás de importações dinâmicas', () => {
    const dailyReport = source('src/hooks/useDailyReportPdf.ts');
    const measurement = source('src/hooks/useMeasurementExports.ts');
    const inventory = source('src/components/warehouse/pdfLazy.ts');
    const requisitions = source('src/components/warehouse/WarehouseRequisitionsTab.tsx');
    const custody = source('src/components/warehouse/WarehouseCustodyTab.tsx');

    expect(dailyReport).toContain("import('jspdf')");
    expect(measurement).toContain("import('jspdf')");
    expect(measurement).toContain("import('xlsx')");
    expect(inventory).toContain("await import('./pdf')");
    expect(requisitions).toContain("await import('./pdf')");
    expect(custody).toContain("import('./pdf')");
  });
});
