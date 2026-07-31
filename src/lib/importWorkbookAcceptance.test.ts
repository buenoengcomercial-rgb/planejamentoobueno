import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { integrateImportedBudget } from '@/components/ImportSyntheticDialog';
import type { Project } from '@/types/project';
import { buildAdditiveFromSyntheticBudgetItems, extractBaseAnalyticCompositions } from './additiveImport';
import { priceNewContractFromAnalytic } from './additiveImport';
import { inspectSyntheticWorkbook, parseSyntheticBudgetFlexible } from './importParser';
import { money2 } from './financialEngine';
import { buildContractImportPayload } from './projectSync';
import { resolveAnalyticComposition } from './analyticLinks';

const workbookPath = process.env.SYNTHETIC_CORRECTION_WORKBOOK;
const acceptance = workbookPath && existsSync(workbookPath) ? it : it.skip;

describe('aceitação da planilha Sintética Correção 02', () => {
  acceptance('preserva valores, EAP e todas as composições Analíticas', async () => {
    const file = readFileSync(workbookPath!);
    const data = Uint8Array.from(file).buffer;
    const inspected = inspectSyntheticWorkbook(data);
    const parsed = parseSyntheticBudgetFlexible(data, {});
    const analytic = await extractBaseAnalyticCompositions(data);

    expect(inspected.detectedBdiPercent).toBeUndefined();
    expect(parsed.bdiPercent).toBeUndefined();
    expect(parsed.items).toHaveLength(402);
    expect(new Set(parsed.items.map(item => item.chapterCode)).size).toBe(7);
    expect(new Set(parsed.items.map(item => item.subchapterCode).filter(Boolean)).size).toBe(44);
    expect(parsed.groups.filter(group => group.kind === 'chapter')).toHaveLength(7);
    expect(parsed.groups.filter(group => group.kind === 'subchapter')).toHaveLength(44);
    expect(parsed.groups.find(group => group.code === '6.7')).toMatchObject({
      kind: 'subchapter',
      requiresDescription: true,
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.items.every(item => item.totalWithBDI === 0)).toBe(true);

    const administration = parsed.items.find(item => item.item === '1.1.1' && item.code === 'ADM04');
    expect(administration).toMatchObject({ totalNoBDI: 0, totalWithBDI: 0 });

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
    const priced = priceNewContractFromAnalytic(parsed.items, analytic.compositions, 27.58);
    expect(money2(priced.items.reduce((sum, item) => sum + item.totalWithBDI, 0))).toBe(5_815_613.47);
    const integration = integrateImportedBudget(project, priced.items, priced.compositions);
    expect(integration.phases.filter(phase => !phase.parentId)).toHaveLength(7);
    expect(integration.phases.filter(phase => !!phase.parentId)).toHaveLength(44);
    expect(integration.phases.reduce((sum, phase) => sum + phase.tasks.length, 0)).toBe(402);

    const administrationBudget = integration.budgetItems.find(item => item.item === '1.1.1' && item.code === 'ADM04');
    const administrationAnalytic = integration.analyticCompositions.find(composition => composition.item === '1.1.1' && composition.code === 'ADM04');
    expect(administrationBudget).toMatchObject({ totalNoBDI: 75_573.18, totalWithBDI: 96_416.22 });
    expect(administrationBudget?.taskId).toBeTruthy();
    expect(administrationAnalytic?.linkedTaskId).toBe(administrationBudget?.taskId);

    const integratedProject: Project = {
      ...project,
      phases: integration.phases,
      budgetItems: integration.budgetItems,
      analyticCompositions: integration.analyticCompositions,
    };
    const additive = buildAdditiveFromSyntheticBudgetItems(integratedProject);
    expect(additive?.compositions).toHaveLength(402);
    const unresolvedLinks = (additive?.compositions ?? []).filter(composition =>
      !composition.baseBudgetItemId
      || !composition.baseAnalyticCompositionId
      || !resolveAnalyticComposition(integratedProject, composition).composition?.inputs.length,
    ).map(composition => ({ item: composition.item, code: composition.code, taskId: composition.taskId }));
    expect(unresolvedLinks).toEqual([]);
    expect(resolveAnalyticComposition(
      integratedProject,
      additive?.compositions.find(composition => composition.code === 'ADM04'),
    ).composition?.inputs.length).toBeGreaterThan(0);

    const atomicPayload = buildContractImportPayload({
      ...integratedProject,
      contractSchemaVersion: 2,
    });
    expect(atomicPayload.budgetItems).toHaveLength(402);
    expect(atomicPayload.analyticCompositions).toHaveLength(402);
    expect(atomicPayload.chapters).toHaveLength(51);
    expect(atomicPayload.tasks).toHaveLength(402);
    expect(atomicPayload.chapters.find(row => row.id === integration.phases.find(phase => phase.customNumber === '6.7')?.id))
      .toMatchObject({ parent_id: expect.any(String) });
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
    expect(parsed.items.every(item => item.totalNoBDI === 0 && item.totalWithBDI === 0)).toBe(true);
    expect(parsed.items.every(item => item.sourceValues?.totalNoBDI === '0.29' && item.sourceValues?.totalWithBDI === '0.29')).toBe(true);
  });
});
