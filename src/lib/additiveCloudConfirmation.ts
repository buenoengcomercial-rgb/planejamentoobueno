import type { Project } from '@/types/project';

export interface AdditiveCloudExpectation {
  additiveId: string;
  version: number;
  status?: 'aprovado' | 'aditivo_contratado';
}

export function matchesAdditiveCloudExpectation(project: Project | null, expected: AdditiveCloudExpectation): boolean {
  return Boolean(project?.additives?.some(additive =>
    additive.id === expected.additiveId
    && additive.version === expected.version
    && additive.status === (expected.status ?? 'aprovado')
    && (expected.status !== 'aditivo_contratado' || (additive.isContracted && !!additive.contractRevisionId)),
  ));
}
