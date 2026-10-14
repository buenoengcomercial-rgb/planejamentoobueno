// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { decodeMeasurementWorkspace, encodeMeasurementWorkspace } from './measurementCloudCodec';
import type { MeasurementWorkspace } from './measurementWorkspace';

async function fixture() {
  const data = measurementFixture();
  const base = prepareIncorporation(await createIncorporationBackup(data.project, data.plans, [])).candidate;
  const plan = base.plans[0];
  plan.storagePath = `${base.projectId}/${plan.id}/drawing.png`;
  const historic = { ...plan, id: 'historic-dxf', name: 'Histórico.dxf', kind: 'dxf' as const,
    storagePath: `${base.projectId}/historic-dxf/older.dxf` };
  base.audit.push({ id: 'drawing-change', at: '2026-10-12T10:00:00Z', actor: { id: 'user', name: 'Teste' },
    action: 'Gerir desenhos', affected: [], before: [], after: [], beforePlans: [historic], afterPlans: [plan],
    planDelta: { kind: 'archive', planId: historic.id, beforePlan: historic } });
  return base;
}

describe('Catálogo remoto completo da Medição', () => {
  it('decodifica dados e histórico completo sem hidratar nenhum arquivo por padrão', async () => {
    const base = await fixture();
    const raw = encodeMeasurementWorkspace(base);
    const parsed = await decodeMeasurementWorkspace(raw, base.projectId);
    expect(encodeMeasurementWorkspace(parsed)).toEqual(raw);
    expect(parsed.plans[0].file).toBeUndefined();
    expect(parsed.audit.at(-1)?.beforePlans?.[0].file).toBeUndefined();
    expect(parsed.audit.at(-1)?.afterPlans?.[0].file).toBeUndefined();
    expect(parsed.audit.at(-1)?.planDelta?.beforePlan?.file).toBeUndefined();
    expect(parsed.entries).toEqual(base.entries);
    expect(parsed.periods).toEqual(base.periods);
    expect(parsed.services).toEqual(base.services);
  });

  it('hidrata arquivos completos somente com resolver explícito de backup e deduplica os caminhos', async () => {
    const base = await fixture();
    const file = new Blob(['preservado para backup'], { type: 'application/octet-stream' });
    const download = vi.fn().mockResolvedValue(file);
    const parsed = await decodeMeasurementWorkspace(encodeMeasurementWorkspace(base), base.projectId, download);
    expect(download).toHaveBeenCalledTimes(2);
    expect(new Set(download.mock.calls.map(([path]) => path))).toEqual(new Set([
      base.plans[0].storagePath, base.audit.at(-1)?.beforePlans?.[0].storagePath,
    ]));
    expect(parsed.plans[0].file).toBe(file);
    expect(parsed.audit.at(-1)?.beforePlans?.[0].file).toBe(file);
    expect(parsed.audit.at(-1)?.afterPlans?.[0].file).toBe(file);
    expect(parsed.audit.at(-1)?.planDelta?.beforePlan?.file).toBe(file);
    expect(encodeMeasurementWorkspace(parsed)).toEqual(encodeMeasurementWorkspace(base));
  });

  it.each(['current', 'beforePlans', 'afterPlans', 'planDelta'] as const)(
    'recusa caminho de arquivo fora da obra no catálogo %s', async target => {
      const base = await fixture();
      const raw = encodeMeasurementWorkspace(base) as MeasurementWorkspace;
      const plan = target === 'current' ? raw.plans[0]
        : target === 'planDelta' ? raw.audit.at(-1)!.planDelta!.beforePlan!
          : raw.audit.at(-1)![target]![0];
      plan.storagePath = `other-project/${plan.id}/drawing.dxf`;
      const download = vi.fn();
      await expect(decodeMeasurementWorkspace(raw, base.projectId)).rejects.toThrow();
      await expect(decodeMeasurementWorkspace(raw, base.projectId, download)).rejects.toThrow();
      expect(download).not.toHaveBeenCalled();
    });

  it('resposta parcial não transforma coleções ausentes em arrays vazios nem altera a entrada', async () => {
    const base = await fixture();
    const raw = encodeMeasurementWorkspace(base) as Record<string, unknown>;
    delete raw.entries;
    const original = structuredClone(raw);
    await expect(decodeMeasurementWorkspace(raw, base.projectId)).rejects.toThrow('incompleta');
    expect(raw).toEqual(original);
    expect(raw).not.toHaveProperty('entries');
  });

  it('preserva a identidade de arquivo imutável ao codificar catálogo sem Blob', async () => {
    const base = await fixture();
    const raw = encodeMeasurementWorkspace(base);
    const catalog = await decodeMeasurementWorkspace(raw, base.projectId);
    expect(encodeMeasurementWorkspace(catalog)).toEqual(raw);
    expect(catalog.plans[0].storagePath).toBe(base.plans[0].storagePath);
    expect(catalog.audit.at(-1)?.beforePlans?.[0].storagePath).toBe(base.audit.at(-1)?.beforePlans?.[0].storagePath);
    expect(JSON.stringify(raw)).not.toContain('file":');
  });
});
