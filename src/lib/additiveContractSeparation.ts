import type { Project } from '@/types/project';
import type { JornadaConfig } from '@/lib/calculations';
import { contractAdditive } from '@/lib/additiveImport';

/** Formaliza o aditivo mantendo a EAP e os quantitativos do contrato-base.
 * Os serviços novos permanecem como itens próprios do aditivo e no seu cronograma. */
export function contractAdditiveKeepingBase(project: Project, additiveId: string, user?: string, jornadaConfig?: JornadaConfig): Project {
  const contracted = contractAdditive(project, additiveId, user, jornadaConfig);
  const originalBudget = (project.budgetItems ?? []).filter(item => item.source !== 'aditivo');
  const additiveBudget = (contracted.budgetItems ?? []).filter(item => item.source === 'aditivo');
  return {
    ...contracted,
    phases: project.phases,
    budgetItems: [...originalBudget, ...additiveBudget],
  };
}
