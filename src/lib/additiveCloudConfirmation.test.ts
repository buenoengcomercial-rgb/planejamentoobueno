import { expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { matchesAdditiveCloudExpectation } from './additiveCloudConfirmation';

it('não confunde aprovação ou confirmação local com contratação recebida da nuvem', () => {
  const project = { additives: [{ id: 'aditivo', status: 'aprovado', version: 1 }] } as Project;
  const expected = { additiveId: 'aditivo', version: 1, status: 'aditivo_contratado' as const };
  expect(matchesAdditiveCloudExpectation(project, expected)).toBe(false);
  expect(matchesAdditiveCloudExpectation({ ...project, additives: [{ ...project.additives![0],
    status: 'aditivo_contratado', isContracted: true }] }, expected)).toBe(false);
  expect(matchesAdditiveCloudExpectation({ ...project, additives: [{ ...project.additives![0],
    status: 'aditivo_contratado', isContracted: true, contractRevisionId: 'revision-1' }] }, expected)).toBe(true);
});
