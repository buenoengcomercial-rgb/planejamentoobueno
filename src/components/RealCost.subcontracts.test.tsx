import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SubcontractsTab } from './RealCost';
import type { Project } from '@/types/project';

const rows = [
  { id: 'a', item: '3.3.1', description: 'Serviço já terceirizado', chapter: '3 Incêndio', laborCost: 100, quantityFinal: 10, unit: 'm' },
  { id: 'b', item: '3.3.2', description: 'Serviço disponível', chapter: '3 Incêndio', laborCost: 200, quantityFinal: 20, unit: 'm' },
  { id: 'c', item: '3.3.3', description: 'Outro serviço disponível', chapter: '3 Incêndio', laborCost: 300, quantityFinal: 30, unit: 'm' },
] as any[];

const analysis = {
  compositions: rows,
  groupTree: [{ phaseId: 'chapter-3', number: '3', name: 'INCÊNDIO', depth: 0, rows, children: [] }],
} as any;

function projectWithContract(): Project {
  return {
    id: 'p1',
    name: 'CPA',
    subcontracts: [{
      id: 'package-a', name: 'Pacote A', contractorName: 'Prestador', contractDate: '2026-08-22', contractedValue: 100,
      status: 'contracted', createdAt: '2026-08-22T00:00:00Z', payments: [],
      items: [{ id: 'allocation-a', compositionId: 'a', item: '3.3.1', description: 'Serviço já terceirizado', unit: 'un', referenceLaborCost: 100, allocationPercent: 100, contractedAmount: 100 }],
    }],
  } as Project;
}

describe('SubcontractsTab', () => {
  it('seleciona os itens elegíveis do capítulo e mantém bloqueado o item de outro pacote', () => {
    render(<SubcontractsTab project={projectWithContract()} analysis={analysis} canManage auditActor={{ userId: 'owner', userName: 'Owner' }} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /novo pacote/i }));

    const chapter = screen.getByLabelText('Selecionar 3 INCÊNDIO') as HTMLInputElement;
    const blocked = screen.getByLabelText('Selecionar item 3.3.1') as HTMLInputElement;
    const available = screen.getByLabelText('Selecionar item 3.3.2') as HTMLInputElement;
    const otherAvailable = screen.getByLabelText('Selecionar item 3.3.3') as HTMLInputElement;
    expect(blocked.disabled).toBe(true);
    fireEvent.click(chapter);
    expect(available.checked).toBe(true);
    expect(otherAvailable.checked).toBe(true);
    expect(screen.getByText('2')).toBeInTheDocument();

    fireEvent.click(available);
    expect(chapter.checked).toBe(false);
    expect(chapter.indeterminate).toBe(true);
  });

  it('mantém os itens recolhidos e mostra o cabeçalho do contrato antes deles', () => {
    const { container } = render(<SubcontractsTab project={projectWithContract()} analysis={analysis} canManage auditActor={{ userId: 'owner', userName: 'Owner' }} onProjectChange={vi.fn()} />);
    const card = screen.getByText('Pacote A').closest('[class*=overflow-hidden]');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('Prestador');
    expect(card).toHaveTextContent('M.O. SINAPI');
    expect(card).toHaveTextContent('Economia');
    const packageHeader = screen.getByRole('button', { name: /alternar itens contratados do pacote pacote a/i });
    expect(packageHeader).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelectorAll('table')).toHaveLength(0);

    fireEvent.click(packageHeader);
    expect(card).toHaveTextContent('Serviço já terceirizado');
    expect(packageHeader).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(screen.getByRole('columnheader', { name: 'Referência SINAPI' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Contrato terceirizado' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Capítulo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Pago' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Saldo' })).not.toBeInTheDocument();
    expect(card).toHaveTextContent(/R\$\s*10,00/);
  });

  it('separa visualmente referência SINAPI, execução e contrato', () => {
    render(<SubcontractsTab project={projectWithContract()} analysis={analysis} canManage auditActor={{ userId: 'owner', userName: 'Owner' }} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /alternar itens contratados do pacote pacote a/i }));
    expect(screen.getByText('Referência SINAPI')).toHaveClass('bg-sky-100/70');
    expect(screen.getByText('Execução')).toHaveClass('bg-muted/70');
    expect(screen.getByText('Contrato terceirizado')).toHaveClass('bg-emerald-100/70');
    expect(screen.getByRole('columnheader', { name: 'Quantidade' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Produzido' })).toBeInTheDocument();
  });

  it('não inventa valor unitário quando a quantidade final é zero', () => {
    const project = projectWithContract();
    project.subcontracts![0] = {
      ...project.subcontracts![0],
      contractedValue: 50,
      items: [{ id: 'zero', compositionId: 'c', item: '3.3.3', description: 'Outro serviço disponível', unit: 'm', referenceLaborCost: 300, allocationPercent: 100, contractedAmount: 50 }],
    };
    rows[2].quantityFinal = 0;
    render(<SubcontractsTab project={project} analysis={analysis} canManage auditActor={{ userId: 'owner', userName: 'Owner' }} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /alternar itens contratados do pacote pacote a/i }));
    expect(screen.getAllByText('Sem base física para pagamento unitário.')).toHaveLength(2);
    rows[2].quantityFinal = 30;
  });

  it('não bloqueia composições distintas só porque uma importação antiga lhes deu a mesma tarefa', () => {
    rows[0].taskId = 'task-compartilhada';
    rows[1].taskId = 'task-compartilhada';
    render(<SubcontractsTab project={projectWithContract()} analysis={analysis} canManage auditActor={{ userId: 'owner', userName: 'Owner' }} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /novo pacote/i }));
    expect(screen.getByLabelText('Selecionar item 3.3.1')).toBeDisabled();
    expect(screen.getByLabelText('Selecionar item 3.3.2')).toBeEnabled();
    expect(screen.getByText(/Composição já vinculada ao pacote: Pacote A/)).toBeInTheDocument();
    delete rows[0].taskId;
    delete rows[1].taskId;
  });

  it('oferece observação ao lançar pagamento e não altera o pacote enquanto o pagamento não for confirmado', () => {
    render(<SubcontractsTab project={projectWithContract()} analysis={analysis} canManage auditActor={{ userId: 'owner', userName: 'Owner' }} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /lançar pagamento/i }));
    expect(screen.getByLabelText('Valor do pagamento')).toBeInTheDocument();
    expect(screen.getByLabelText('Observação do pagamento')).toHaveAttribute('placeholder', expect.stringMatching(/descreva o serviço/i));
  });
});
