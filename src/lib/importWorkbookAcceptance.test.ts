import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { integrateImportedBudget } from '@/components/ImportSyntheticDialog';
import type { Project } from '@/types/project';
import { extractBaseAnalyticCompositions } from './additiveImport';
import { inspectSyntheticWorkbook, parseSyntheticBudgetFlexible } from './importParser';

const workbookPath = process.env.SYNTHETIC_CORRECTION_WORKBOOK;
const acceptance = workbookPath && existsSync(workbookPath) ? it : it.skip;

describe('aceitação da planilha Sintética Correção 02', () => {
  acceptance('preserva valores, EAP e todas as composições Analíticas', async () => {
    const file = readFileSync(workbookPath!);
    const data = Uint8Array.from(file).buffer;
    const inspected = inspectSyntheticWorkbook(data);
    const parsed = parseSyntheticBudgetFlexible(data, {});
    const analytic = await extractBaseAnalyticCompositions(data);

    expect(inspected.detectedBdiPercent).toBe(27.58);
    expect(parsed.bdiPercent).toBe(27.58);
    expect(parsed.items).toHaveLength(402);
    expect(new Set(parsed.items.map(item => item.chapterCode)).size).toBe(7);
    expect(new Set(parsed.items.map(item => item.subchapterCode).filter(Boolean)).size).toBe(43);

    const administration = parsed.items.find(item => item.item === '1.1.1' && item.code === 'ADM04');
    expect(administration).toMatchObject({
      totalNoBDI: 75_573.18,
      totalWithBDI: 96_416.22,
    });

    expect(analytic).toMatchObject({ linkedCount: 402, totalInputs: 1711, hasAnalyticSheet: true });
    expect(analytic.compositions).toHaveLength(402);

    const project: Project = {
      id: 'nova-obra',
      name: 'Nova obra',
      startDate: '2026-07-30',
      endDate: '2026-07-30',
      phases: [],
      totalBudget: 0,
    };
    const integration = integrateImportedBudget(project, parsed.items, analytic.compositions);
    expect(integration.phases.filter(phase => !phase.parentId)).toHaveLength(7);
    expect(integration.phases.filter(phase => !!phase.parentId)).toHaveLength(43);
    expect(integration.phases.reduce((sum, phase) => sum + phase.tasks.length, 0)).toBe(402);

    const administrationBudget = integration.budgetItems.find(item => item.item === '1.1.1' && item.code === 'ADM04');
    const administrationAnalytic = integration.analyticCompositions.find(composition => composition.item === '1.1.1' && composition.code === 'ADM04');
    expect(administrationBudget?.taskId).toBeTruthy();
    expect(administrationAnalytic?.linkedTaskId).toBe(administrationBudget?.taskId);
  });

  it('preserva 33 totais da fonte que diferem do cálculo por R$ 0,01', () => {
    const rows: unknown[][] = Array.from({ length: 9 }, () => []);
    rows[7] = ['', '', '', '', '', '', '', '', '% B.D.I', '0%'];
    rows[8] = ['Item', 'Código', 'Banco', 'Descrição', 'Quant.', 'Un', 'Valor Unit', '', 'Valor Unit com BDI', 'Total'];
    for (let index = 0; index < 33; index++) {
      rows.push([`1.1.${index + 1}`, `R${index + 1}`, 'PRÓPRIO', 'Linha de arredondamento', 3, 'un', 0.1, 0.29, 0.1, 0.29]);
    }
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'SINTETICA');
    const data = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const parsed = parseSyntheticBudgetFlexible(data, {});

    expect(parsed.items).toHaveLength(33);
    expect(parsed.items.every(item => item.totalNoBDI === 0.29 && item.totalWithBDI === 0.29)).toBe(true);
  });
});
