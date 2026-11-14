import type { Additive } from '@/types/project';
import { additiveServiceId } from './contractedAdditiveSchedule';
import type { MonthlyLine } from './measurementWorkspace';

/** Fill display metadata from the approval used at incorporation. */
export function withMeasurementAdditiveReferences(lines: MonthlyLine[], additives: readonly Additive[] = []): MonthlyLine[] {
  const versions = new Map(additives.map(additive => [additive.id,
    new Map(additive.approvalSnapshots?.map(snapshot => [snapshot.version,
      new Map(snapshot.compositions.filter(composition => composition.isNewService)
        .map(composition => [additiveServiceId(additive.id, composition.id), composition]))])),
  ]));
  return lines.map(line => {
    const service = line.service;
    if (!service.additiveId || service.additiveVersion == null || (service.code?.trim() && service.bank?.trim())) return line;
    const source = versions.get(service.additiveId)?.get(service.additiveVersion)?.get(service.id);
    if (!source) return line;
    const code = service.code?.trim() ? service.code : source.code?.trim();
    const bank = service.bank?.trim() ? service.bank : source.bank?.trim();
    return { ...line, service: { ...service, code, bank } };
  });
}
