import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project, WarehouseFiscalNote } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import { PROJECT_DRAFT_VERSION, type StoredProjectDraft } from '@/lib/cloudProjectDrafts';
import CloudDraftRecoveryDialog from './CloudDraftRecoveryDialog';

function project(id: string, supplier: string, invoiceNumber: string): Project {
  const note: WarehouseFiscalNote = {
    id: `${id}-note`,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
    status: 'aprovada',
    origin: 'upload',
    sourceFileName: `${invoiceNumber}.pdf`,
    supplierName: supplier,
    supplierCnpj: '18.787.482/0001-37',
    invoiceNumber,
    totalAmount: 100,
    items: [],
    createdBy: { userName: supplier.includes('KENNEDY') ? 'Kennedy' : 'Kelper' },
  };
  const value: Project = {
    id,
    name: 'CPA OBRA',
    startDate: '2026-08-01',
    endDate: '2027-08-01',
    totalBudget: 0,
    phases: [],
    warehouse: emptyWarehouse(),
  };
  value.warehouse!.fiscalNotes = [note];
  return value;
}

describe('CloudDraftRecoveryDialog', () => {
  it('compara nuvem e aparelho e deixa as duas escolhas explícitas', () => {
    const cloudProject = project('project-1', 'FORNECEDOR ANTIGO', '999');
    const localProject = project('project-1', 'KENNEDY METAIS', '000106809');
    const draft: StoredProjectDraft = {
      version: PROJECT_DRAFT_VERSION,
      baseUpdatedAt: '2026-08-18T10:00:00.000Z',
      localDraftUpdatedAt: '2026-08-18T10:01:00.000Z',
      project: localProject,
    };
    render(
      <CloudDraftRecoveryDialog
        open
        cloudProject={cloudProject}
        draft={draft}
        canRestore
        onOpenChange={vi.fn()}
        onUseCloud={vi.fn()}
        onRestoreWarehouse={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Dados atuais da nuvem')).toBeInTheDocument();
    expect(within(dialog).getByText('Cópia deste aparelho')).toBeInTheDocument();
    expect(within(dialog).getByText('FORNECEDOR ANTIGO')).toBeInTheDocument();
    expect(within(dialog).getByText('KENNEDY METAIS')).toBeInTheDocument();
    expect(within(dialog).getByText(/Equipamentos serão preservados/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Usar dados da nuvem' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Restaurar Almoxarifado deste aparelho' })).toBeEnabled();
  });

  it('permite fechar para revisar sem escolher silenciosamente', () => {
    const onOpenChange = vi.fn();
    const cloudProject = project('project-1', 'NUVEM', '1');
    const draft: StoredProjectDraft = {
      version: PROJECT_DRAFT_VERSION,
      baseUpdatedAt: null,
      localDraftUpdatedAt: '2026-08-18T10:01:00.000Z',
      project: project('project-1', 'LOCAL', '2'),
    };
    render(
      <CloudDraftRecoveryDialog
        open
        cloudProject={cloudProject}
        draft={draft}
        canRestore
        onOpenChange={onOpenChange}
        onUseCloud={vi.fn()}
        onRestoreWarehouse={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Voltar e revisar' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
