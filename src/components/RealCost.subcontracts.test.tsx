import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SubcontractsTab } from './RealCost';
import type { Project } from '@/types/project';

type TestRow = { id: string; item: string; description: string; chapter: string; laborCost: number; quantityFinal: number; unit: string; taskId?: string };

const rows: TestRow[] = [
  { id: 'a', item: '3.3.1', description: 'Serviço já terceirizado', chapter: '3 Incêndio', laborCost: 100, quantityFinal: 10, unit: 'm' },
  { id: 'b', item: '3.3.2', description: 'Serviço disponível', chapter: '3 Incêndio', laborCost: 200, quantityFinal: 20, unit: 'm' },
  { id: 'c', item: '3.3.3', description: 'Outro serviço disponível', chapter: '3 Incêndio', laborCost: 300, quantityFinal: 30, unit: 'm' },
];

const analysis = {
  compositions: rows,
  groupTree: [{ phaseId: 'chapter-3', number: '3', name: 'INCÊNDIO', depth: 0, rows, children: [] }],
} as unknown as Parameters<typeof SubcontractsTab>[0]['analysis'];

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
    expect(screen.queryByText('Valores de mão de obra por capítulo')).not.toBeInTheDocument();
    expect(screen.queryByText('R$/h')).not.toBeInTheDocument();
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

  it('salva a simulação limitada ao contratado sem alterar a produção real ou pagamentos', () => {
    const onProjectChange = vi.fn();
    const view = render(<SubcontractsTab project={projectWithContract()} analysis={analysis} canManage auditActor={{ userId: 'owner', userName: 'Owner' }} onProjectChange={onProjectChange} />);
    fireEvent.click(screen.getByRole('button', { name: /alternar itens contratados do pacote pacote a/i }));

    expect(screen.getByRole('columnheader', { name: 'Simulação' })).toBeInTheDocument();
    const simulationInput = screen.getAllByLabelText('Simulação de Serviço já terceirizado')[0];
    fireEvent.change(simulationInput, { target: { value: '7' } });
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(screen.getByText('Simulado').parentElement).toHaveTextContent(/R\$\s*70,00/);
    fireEvent.blur(simulationInput);

    const nextProject = onProjectChange.mock.calls[0][0] as Project;
    const nextContract = nextProject.subcontracts?.[0];
    expect(nextContract?.items[0].simulatedExecutedQuantity).toBe(7);
    view.rerender(<SubcontractsTab project={nextProject} analysis={analysis} canManage auditActor={{ userId: 'owner', userName: 'Owner' }} onProjectChange={onProjectChange} />);
    expect(screen.getByText('Simulado').parentElement).toHaveTextContent(/R\$\s*70,00/);

    const limitedInput = screen.getAllByLabelText('Simulação de Serviço já terceirizado')[0];
    fireEvent.change(limitedInput, { target: { value: '12' } });
    expect(onProjectChange).toHaveBeenCalledTimes(1);
    fireEvent.blur(limitedInput);
    const limitedProject = onProjectChange.mock.calls[1][0] as Project;
    const limitedContract = limitedProject.subcontracts?.[0];
    expect(limitedContract?.items[0].simulatedExecutedQuantity).toBe(10);
    expect(limitedContract?.payments).toEqual([]);
    expect(limitedContract?.items[0].contractedAmount).toBe(100);
  });

  it('deixa a simulação somente para leitura sem permissão de gestão', () => {
    render(<SubcontractsTab project={projectWithContract()} analysis={analysis} canManage={false} auditActor={{ userId: 'viewer', userName: 'Viewer' }} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /alternar itens contratados do pacote pacote a/i }));

    expect(screen.getAllByLabelText('Simulação de Serviço já terceirizado')[0]).toBeDisabled();
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

  it('altera atividades, recalcula o rateio atual e registra o motivo da revisão', () => {
    const onProjectChange = vi.fn();
    render(<SubcontractsTab project={projectWithContract()} analysis={analysis} canManage auditActor={{ userId: 'owner', userName: 'Owner' }} onProjectChange={onProjectChange} />);
    fireEvent.click(screen.getByRole('button', { name: /alterar atividades/i }));
    fireEvent.click(screen.getByLabelText('Selecionar item 3.3.1'));
    fireEvent.click(screen.getByLabelText('Selecionar item 3.3.2'));
    fireEvent.change(screen.getByLabelText('Motivo da alteração do contrato'), { target: { value: 'Troca de frente de serviço' } });
    fireEvent.click(screen.getByRole('button', { name: /aplicar alteração/i }));

    const nextProject = onProjectChange.mock.calls[0][0] as Project;
    const nextContract = nextProject.subcontracts?.[0];
    expect(nextContract?.items.map(item => item.compositionId)).toEqual(['b']);
    expect(nextContract?.amendments?.[0].reason).toBe('Troca de frente de serviço');
    expect(nextContract?.amendments?.[0].previousItems.map(item => item.compositionId)).toEqual(['a']);
  });

  it('mostra histórico do pacote, indicador físico e filtros durante uma alteração', () => {
    const project = projectWithContract();
    project.subcontracts![0] = {
      ...project.subcontracts![0],
      amendments: [{
        id: 'amendment-1', date: '2026-08-23', reason: 'Ajuste de escopo',
        previousContractedValue: 120, nextContractedValue: 100,
        previousItems: [], nextItems: project.subcontracts![0].items,
        createdAt: '2026-08-23T00:00:00Z',
      }],
    };
    render(<SubcontractsTab project={project} analysis={analysis} canManage auditActor={{ userId: 'owner', userName: 'Owner' }} onProjectChange={vi.fn()} />);
    expect(screen.getByText('Itens com produção')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /histórico de alterações/i }));
    expect(screen.getByText(/Ajuste de escopo/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /excluir registro do histórico/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /alterar atividades/i }));
    expect(screen.getByRole('button', { name: 'Já contratadas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Com produção' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sem tarefa' })).toBeInTheDocument();
  });

  it('permite excluir um registro do histórico apenas quando a permissão de proprietário é concedida', () => {
    const project = projectWithContract();
    project.subcontracts![0] = {
      ...project.subcontracts![0],
      amendments: [{
        id: 'amendment-owner', date: '2026-08-23', reason: 'Registro removível',
        previousContractedValue: 100, nextContractedValue: 100,
        previousItems: [], nextItems: project.subcontracts![0].items,
        createdAt: '2026-08-23T00:00:00Z',
      }],
    };
    const onProjectChange = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SubcontractsTab project={project} analysis={analysis} canManage canDeleteHistory auditActor={{ userId: 'owner', userName: 'Owner' }} onProjectChange={onProjectChange} />);
    fireEvent.click(screen.getByRole('button', { name: /histórico de alterações/i }));
    fireEvent.click(screen.getByRole('button', { name: /excluir registro do histórico: registro removível/i }));
    expect(confirm).toHaveBeenCalled();
    expect((onProjectChange.mock.calls[0][0] as Project).subcontracts?.[0].amendments).toEqual([]);
    confirm.mockRestore();
  });
});
