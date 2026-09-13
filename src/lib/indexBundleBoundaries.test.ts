import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('fronteiras leves do Index', () => {
  it('delega a projeção de aditivo apenas para Cronograma e Rotina', () => {
    const index = source('src/pages/Index.tsx');

    expect(index).not.toContain("from '@/lib/additiveSchedule'");
    expect(index).not.toContain("from '@/lib/operationalProject'");
    expect(index).toContain("import('@/components/OperationalManagementRoutine')");
    expect(index).toContain("import('@/components/OperationalGanttChart')");
  });

  it('usa o núcleo leve do calendário sem importar a interface de configuração', () => {
    const index = source('src/pages/Index.tsx');

    expect(index).toContain("from '@/lib/obraConfig'");
    expect(index).not.toContain("from '@/components/ConfiguracaoObra'");
  });
});
