import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Additive, AdditiveComposition, Project } from '@/types/project';
import { syncAdditiveScheduleDraft } from '@/lib/additiveSchedule';
import AdditiveSchedule from './AdditiveSchedule';

const contractedComposition: AdditiveComposition = {
  id: 'contracted-hydrant', item: '2.1.1', code: 'HID-BASE', bank: 'SINAPI',
  description: 'Abrigo para hidrante contratado', quantity: 1, originalQuantity: 1,
  addedQuantity: 1, suppressedQuantity: 0, changeKind: 'acrescido', unit: 'UN',
  unitPriceNoBDI: 80, unitPriceWithBDI: 100, total: 100, inputs: [],
  taskId: 'hydrant-task', phaseId: 'phase-1',
};

const newComposition: AdditiveComposition = {
  id: 'new-hydrant-458', item: '2.9.1', code: 'HID-458', bank: 'PRÓPRIO',
  description: 'Abrigo para hidrante, linha 458', quantity: 1, originalQuantity: 0,
  addedQuantity: 1, suppressedQuantity: 0, changeKind: 'acrescido', unit: 'UN',
  unitPriceNoBDI: 120, unitPriceWithBDI: 150, total: 150, inputs: [],
  phaseId: 'phase-1', phaseChain: '2.9 SERVIÇOS - ITENS NOVOS', isNewService: true,
};

const additive: Additive = {
  id: 'add-1', name: '1º Aditivo', importedAt: '2026-08-01T00:00:00.000Z',
  status: 'aprovado', effectiveDate: '2026-08-10', version: 1, bdiPercent: 25,
  compositions: [contractedComposition, newComposition],
};

const baseProject: Project = {
  id: 'project-blocker-dialog', name: 'Obra teste', startDate: '2026-08-01',
  endDate: '2026-10-31', totalBudget: 1000,
  phases: [{
    id: 'phase-1', name: '2.1 ABRIGO, TUBULAÇÕES E CONEXÕES', color: '#64748b',
    tasks: [{
      id: 'door-task', name: 'Porta de Vidro', phase: 'phase-1', startDate: '2026-08-03', duration: 1,
      dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0,
      quantity: 1, unit: 'UN', unitPrice: 200, unitPriceNoBDI: 160,
    }, {
      id: 'hydrant-task', name: 'Abrigo para hidrante contratado', phase: 'phase-1', startDate: '2026-08-04', duration: 2,
      dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0,
      quantity: 1, unit: 'UN', unitPrice: 100, unitPriceNoBDI: 80,
    }],
  }],
  additives: [additive],
};

describe('AdditiveSchedule - composições bloqueadoras', () => {
  beforeEach(() => localStorage.clear());

  it('lista itens novos antes dos contratados, salva ambos e restaura a seleção', () => {
    const project = syncAdditiveScheduleDraft(baseProject, additive.id, '2026-08-14T12:00:00.000Z');
    const onProjectChange = vi.fn();
    const view = render(<AdditiveSchedule project={project} onProjectChange={onProjectChange} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Suspender Porta de Vidro' }));
    const dialog = screen.getByRole('dialog');
    const newGroup = within(dialog).getByTestId('blocking-group-new');
    const contractedGroup = within(dialog).getByTestId('blocking-group-contracted');

    expect(newGroup).toHaveTextContent('SERVIÇOS - ITENS NOVOS');
    expect(newGroup).toHaveTextContent('Abrigo para hidrante, linha 458');
    expect(contractedGroup).toHaveTextContent('ITENS CONTRATADOS ALTERADOS');
    expect(contractedGroup).toHaveTextContent('Abrigo para hidrante contratado');
    expect(newGroup.compareDocumentPosition(contractedGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(newGroup).getByRole('checkbox', { name: /HID-458/i }));
    fireEvent.click(within(contractedGroup).getByRole('checkbox', { name: /HID-BASE/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspender tarefa' }));

    expect(onProjectChange).toHaveBeenCalledTimes(1);
    const saved = onProjectChange.mock.calls[0][0] as Project;
    expect(saved.additives?.[0].scheduleDraft?.dependencyBlocks).toEqual([{
      taskId: 'door-task',
      compositionIds: ['new-hydrant-458', 'contracted-hydrant'],
      note: undefined,
    }]);

    view.rerender(<AdditiveSchedule project={saved} onProjectChange={onProjectChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar bloqueadores de Porta de Vidro' }));
    const reopened = screen.getByRole('dialog');
    expect(within(reopened).getByRole('checkbox', { name: /HID-458/i })).toBeChecked();
    expect(within(reopened).getByRole('checkbox', { name: /HID-BASE/i })).toBeChecked();
  });
});
