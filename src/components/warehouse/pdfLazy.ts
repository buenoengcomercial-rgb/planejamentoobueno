import type { Project, WarehouseInventorySession } from '@/types/project';

/** Mantém o gerador pesado fora da subaba até a ação explícita do usuário. */
export async function generateInventoryReportPdf(project: Project, session: WarehouseInventorySession) {
  const { generateInventoryReportPdf: generate } = await import('./pdf');
  return await generate(project, session);
}
