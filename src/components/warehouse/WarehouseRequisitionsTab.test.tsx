import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { addMovement, emptyWarehouse } from '@/lib/warehouse';
import WarehouseRequisitionsTab from './WarehouseRequisitionsTab';

function projectWithMaterials(count = 15): Project {
  let current: Project = {
    id: 'withdrawals-project',
    name: 'Obra teste',
    startDate: '2026-08-01',
    endDate: '2026-12-31',
    totalBudget: 0,
    phases: [{ id: 'chapter-1', name: 'Prédio 1', color: '#000', tasks: [] }],
    teams: [{ code: 'alpha', label: 'Alpha', active: true, composition: 'Ajudante', bgColor: '#eee', textColor: '#111', borderColor: '#999', barColor: '#555' }],
    warehouse: emptyWarehouse(),
  };
  for (let index = 0; index < count; index += 1) {
    current = addMovement(current, {
      type: 'entrada',
      date: '2026-08-01',
      itemKey: `material-${index}`,
      itemCode: `MAT-${String(index).padStart(3, '0')}`,
      itemDescription: index === count - 1 ? 'Válvula de Aço Carbono' : `Material disponível ${index}`,
      itemUnit: 'UN',
      quantity: 10,
      unitPrice: 5,
    });
  }
  return current;
}

function expandAllWithdrawalDateGroups() {
  screen.getAllByTestId('withdrawal-date-group').filter(element => element.tagName === 'TR').forEach(element => {
    const button = within(element).getByRole('button', { name: /expandir requisições/i });
    fireEvent.click(button);
  });
}

describe('WarehouseRequisitionsTab', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  });

  it('abre retirada e cautela em janelas separadas do histórico', () => {
    const project = projectWithMaterials(1);
    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    expect(screen.getByRole('dialog', { name: 'Nova retirada de materiais' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog', { name: 'Nova retirada de materiais' })).not.toBeInTheDocument();

    const equipmentTab = screen.getByRole('tab', { name: /Equipamentos \/ Cautelas/i });
    fireEvent.mouseDown(equipmentTab, { button: 0, ctrlKey: false });
    fireEvent.click(equipmentTab);
    fireEvent.click(screen.getByRole('button', { name: /Nova cautela/i }));
    expect(screen.getByRole('dialog', { name: 'Nova cautela de equipamentos' })).toBeInTheDocument();
  });

  it('confirma antes de descartar uma retirada em preenchimento', () => {
    render(<WarehouseRequisitionsTab project={projectWithMaterials(1)} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.change(document.getElementById('withdrawal-chapter')!, { target: { value: 'chapter-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByText('Descartar retirada em preenchimento?')).toBeInTheDocument();
  });

  it('seleciona um recebedor cadastrado e permite criar outro já em maiúsculas', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.receivers = [{ name: 'JOÃO DA SILVA' }];
    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.click(screen.getByText('JOÃO DA SILVA'));
    expect(screen.getByRole('combobox', { name: 'Quem recebeu' })).toHaveTextContent('JOÃO DA SILVA');

    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.change(screen.getByPlaceholderText('Buscar ou criar recebedor...'), { target: { value: 'feilpe' } });
    fireEvent.click(screen.getByText('Criar “FELIPE”'));
    expect(screen.getByRole('combobox', { name: 'Quem recebeu' })).toHaveTextContent('FELIPE');
  });

  it('mostra todos os materiais antes da busca e filtra palavras ignorando acentos', () => {
    render(<WarehouseRequisitionsTab project={projectWithMaterials()} onProjectChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    const available = screen.getByLabelText('Materiais disponíveis');
    expect(within(available).getAllByRole('button')).toHaveLength(15);

    fireEvent.click(within(available).getAllByRole('button')[0]);
    expect(screen.getByText('Materiais selecionados')).toBeInTheDocument();
    expect(screen.getByText('1 item(ns)')).toBeInTheDocument();
    expect(within(available).getAllByRole('button')).toHaveLength(14);

    fireEvent.change(screen.getByPlaceholderText('Buscar por código, descrição ou unidade'), { target: { value: 'valvula aco' } });
    expect(within(available).getAllByRole('button')).toHaveLength(1);
    expect(within(available).getByText('Válvula de Aço Carbono')).toBeInTheDocument();
  });

  it('usa histórico em largura total com detalhes expansíveis', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.requisitions = [{
      id: 'req-1', number: 'REQ-2026-0001', date: '2026-08-18', status: 'entregue',
      chapterId: 'chapter-1', chapterName: '1 Prédio 1', teamId: 'alpha', teamName: 'Alpha',
      receiverName: 'João', requesterName: 'João', signatureReceiver: 'assinatura', createdAt: '2026-08-18T10:00:00.000Z',
      items: [{ itemKey: 'material-0', code: 'MAT-000', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
    }];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    expect(screen.queryByText('Comprovante')).not.toBeInTheDocument();
    expandAllWithdrawalDateGroups();
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0001/i }));
    expect(screen.getAllByRole('button', { name: 'PDF' })).toHaveLength(2);
    expect(screen.getAllByText('Material disponível 0').length).toBeGreaterThan(1);
    expect(screen.getAllByRole('columnheader', { name: 'Retirado' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('columnheader', { name: 'Devolvido' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('columnheader', { name: 'Em campo' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('columnheader', { name: 'Equipe' })).not.toBeInTheDocument();
  });

  it('destaca em azul a requisição aberta e seu detalhe associado', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.requisitions = [{
      id: 'req-highlight', number: 'REQ-2026-0010', date: '2026-08-18', status: 'entregue', chapterId: 'chapter-1',
      receiverName: 'João', requesterName: 'João', signatureReceiver: 'assinatura', createdAt: '2026-08-18T10:00:00.000Z',
      items: [{ itemKey: 'material-0', code: 'MAT-000', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
    }];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    expandAllWithdrawalDateGroups();
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0010/i }));

    expect(screen.getByTestId('withdrawal-history-row')).toHaveClass('bg-success/20');
    expect(screen.getAllByTestId('withdrawal-history-details')[0]).toHaveClass('bg-success/5');
    expect(screen.getAllByTestId('withdrawal-history-details')[1]).toHaveClass('bg-success/5');
    expect(screen.getByTestId('withdrawal-history-row').querySelector('svg')).toHaveClass('text-success');

    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0010/i }));
    expect(screen.queryByTestId('withdrawal-history-details')).not.toBeInTheDocument();
  });

  it('mantém a expansão abaixo do acionador e diferencia os níveis por contraste', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.requisitions = [
      { id: 'req-first', number: 'REQ-2026-0001', date: '2026-08-18', status: 'entregue', chapterId: 'chapter-1', receiverName: 'Ana', createdAt: '2026-08-18T10:00:00.000Z', items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 1 }] },
      { id: 'req-second', number: 'REQ-2026-0002', date: '2026-08-18', status: 'entregue', chapterId: 'chapter-1', receiverName: 'Bia', createdAt: '2026-08-18T09:00:00.000Z', items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 1 }] },
    ];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    const building = screen.getAllByTestId('withdrawal-building-group').find(element => element.tagName === 'TR')!;
    const date = screen.getAllByTestId('withdrawal-date-group').find(element => element.tagName === 'TR')!;
    expect(building).toHaveClass('bg-primary/15');
    expect(date).toHaveClass('bg-muted/80');

    fireEvent.click(within(date).getByRole('button', { name: /expandir requisições/i }));
    const rows = screen.getAllByTestId('withdrawal-history-row');
    expect(rows[0].previousElementSibling).toBe(date);
    expect(rows[1]).toHaveClass('bg-muted/40');

    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0001/i }));
    const desktopDetail = screen.getAllByTestId('withdrawal-history-details').find(element => element.tagName === 'TR')!;
    expect(rows[0].nextElementSibling).toBe(desktopDetail);
    expect(desktopDetail).toHaveClass('bg-success/5');
    expect(desktopDetail.querySelector('td')).toHaveClass('pl-8');
    expect(desktopDetail.querySelector('td > div')).toHaveClass('border-l-success/70');
    expect(rows[1].previousElementSibling).toBe(desktopDetail);
  });

  it('mantém no detalhe somente materiais, ações e observação preenchida', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.requisitions = [{
      id: 'req-clean-detail', number: 'REQ-2026-0040', date: '2026-08-18', status: 'entregue', chapterId: 'chapter-1',
      receiverName: 'Ana', createdAt: '2026-08-18T10:00:00.000Z', notes: 'Aplicar no térreo',
      items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
    }];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    expandAllWithdrawalDateGroups();
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0040/i }));

    const desktopDetail = screen.getAllByTestId('withdrawal-history-details').find(element => element.tagName === 'TR')!;
    expect(within(desktopDetail).getByRole('button', { name: 'PDF' })).toBeInTheDocument();
    expect(within(desktopDetail).getByText('Aplicar no térreo')).toBeInTheDocument();
    expect(within(desktopDetail).getByText('Material disponível 0')).toBeInTheDocument();
    expect(within(desktopDetail).queryByText('REQ-2026-0040')).not.toBeInTheDocument();
    expect(within(desktopDetail).queryByText('Hierarquia / destino')).not.toBeInTheDocument();
    expect(within(desktopDetail).queryByText('Data da operação')).not.toBeInTheDocument();
    expect(within(desktopDetail).queryByText('Registro / atualização')).not.toBeInTheDocument();
    expect(within(desktopDetail).queryByText(/Incluído por:/)).not.toBeInTheDocument();
  });

  it('não reserva espaço para observação vazia no detalhe', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.requisitions = [{
      id: 'req-no-notes', number: 'REQ-2026-0041', date: '2026-08-18', status: 'entregue', chapterId: 'chapter-1',
      receiverName: 'Ana', createdAt: '2026-08-18T10:00:00.000Z', items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
    }];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    expandAllWithdrawalDateGroups();
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0041/i }));

    const desktopDetail = screen.getAllByTestId('withdrawal-history-details').find(element => element.tagName === 'TR')!;
    expect(within(desktopDetail).queryByText(/Observação:/)).not.toBeInTheDocument();
  });

  it('mantém destacadas todas as requisições abertas', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.requisitions = [
      { id: 'req-first', number: 'REQ-2026-0001', date: '2026-08-18', status: 'entregue', chapterId: 'chapter-1', receiverName: 'Ana', createdAt: '2026-08-18T10:00:00.000Z', items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 2 }] },
      { id: 'req-second', number: 'REQ-2026-0002', date: '2026-08-19', status: 'entregue', chapterId: 'chapter-1', receiverName: 'Bia', createdAt: '2026-08-19T10:00:00.000Z', items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 1 }] },
    ];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    expandAllWithdrawalDateGroups();
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0001/i }));
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0002/i }));

    expect(screen.getAllByTestId('withdrawal-history-row')).toHaveLength(2);
    expect(screen.getAllByTestId('withdrawal-history-row').every(row => row.classList.contains('bg-success/20'))).toBe(true);
    expect(screen.getAllByTestId('withdrawal-history-details')).toHaveLength(4);
  });

  it('deixa aberta somente a data operacional atual até que o usuário a altere', () => {
    const project = projectWithMaterials(1);
    const today = new Date().toISOString().slice(0, 10);
    project.warehouse!.requisitions = [
      { id: 'req-today', number: 'REQ-2026-0020', date: today, status: 'entregue', chapterId: 'chapter-1', receiverName: 'Ana', createdAt: `${today}T10:00:00.000Z`, items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 1 }] },
      { id: 'req-before', number: 'REQ-2026-0019', date: '2026-08-18', status: 'entregue', chapterId: 'chapter-1', receiverName: 'Bia', createdAt: '2026-08-18T10:00:00.000Z', items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 1 }] },
    ];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    expect(screen.getByTestId('withdrawal-history-row')).toHaveTextContent('REQ-2026-0020');
    expect(screen.queryByText('REQ-2026-0019')).not.toBeInTheDocument();
    const olderDate = screen.getAllByTestId('withdrawal-date-group').filter(element => element.tagName === 'TR').find(element => element.textContent?.includes('18/08/2026'))!;
    fireEvent.click(within(olderDate).getByRole('button', { name: /expandir requisições/i }));
    expect(screen.getAllByText('REQ-2026-0019')).toHaveLength(2);
  });

  it('mostra a correção de retirada somente quando recebe permissão de Proprietário', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.requisitions = [{
      id: 'req-owner', number: 'REQ-2026-0009', date: '2026-08-18', status: 'entregue', chapterId: 'chapter-1', receiverName: 'João', requesterName: 'João', signatureReceiver: 'assinatura', createdAt: '2026-08-18T10:00:00.000Z',
      items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
    }];
    const first = render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    expandAllWithdrawalDateGroups();
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0009/i }));
    expect(screen.queryByRole('button', { name: /Corrigir retirada/i })).not.toBeInTheDocument();
    first.unmount();

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} canEdit />);
    expandAllWithdrawalDateGroups();
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0009/i }));
    const correctionButtons = screen.getAllByRole('button', { name: /Corrigir retirada/i });
    expect(correctionButtons.length).toBeGreaterThan(0);
    fireEvent.click(correctionButtons[0]);
    expect(screen.getByLabelText('Prédio ou destino corrigido')).toHaveValue('chapter-1');
  });

  it('lista somente capítulos principais ao corrigir o prédio ou destino', () => {
    const project = projectWithMaterials(1);
    project.phases = [
      { id: 'building-a', name: 'Prédio A', color: '#000', tasks: [], order: 0 },
      { id: 'front-a', name: 'Frente A', color: '#000', tasks: [], parentId: 'building-a', order: 0 },
      { id: 'building-b', name: 'Prédio B', color: '#000', tasks: [], order: 1 },
    ];
    project.warehouse!.requisitions = [{
      id: 'req-destination', number: 'REQ-2026-0011', date: '2026-08-18', status: 'entregue', chapterId: 'building-a', receiverName: 'João', requesterName: 'João', signatureReceiver: 'assinatura', createdAt: '2026-08-18T10:00:00.000Z',
      items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
    }];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} canEdit />);
    expandAllWithdrawalDateGroups();
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0011/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /Corrigir retirada/i })[0]);

    const destinations = within(screen.getByLabelText('Prédio ou destino corrigido')).getAllByRole('option').map(option => option.textContent);
    expect(destinations).toEqual(['Selecione', '1 · Prédio A', '2 · Prédio B']);
  });

  it('lista somente capítulos principais ao abrir uma nova retirada', () => {
    const project = projectWithMaterials(1);
    project.phases = [
      { id: 'building-a', name: 'Prédio A', color: '#000', tasks: [], order: 0 },
      { id: 'front-a', name: 'Frente A', color: '#000', tasks: [], parentId: 'building-a', order: 0 },
      { id: 'building-b', name: 'Prédio B', color: '#000', tasks: [], order: 1 },
    ];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));

    const destinations = within(screen.getByLabelText('Prédio / capítulo')).getAllByRole('option').map(option => option.textContent);
    expect(destinations).toEqual(['Selecione', '1 · Prédio A', '2 · Prédio B']);
  });

  it('prioriza a devolução registrada mais recentemente e mostra data e hora do registro', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.requisitions = [
      {
        id: 'req-older', number: 'REQ-2026-0001', date: '2026-08-20', status: 'entregue', chapterId: 'chapter-1', chapterName: 'Prédio 1',
        receiverName: 'João', requesterName: 'João', signatureReceiver: 'assinatura', createdAt: '2026-08-20T14:00:00.000Z',
        items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
      },
      {
        id: 'req-returned', number: 'REQ-2026-0002', date: '2026-08-20', status: 'entregue', chapterId: 'chapter-1', chapterName: 'Prédio 1',
        receiverName: 'Maria', requesterName: 'Maria', signatureReceiver: 'assinatura', createdAt: '2026-08-20T08:00:00.000Z',
        items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
      },
    ];
    project.warehouse!.movements.push({
      id: 'return-latest', type: 'devolucao', originType: 'return', requisitionId: 'req-returned', date: '2026-08-20', createdAt: '2026-08-20T16:30:00.000Z',
      itemKey: 'material-0', itemDescription: 'Material disponível 0', itemUnit: 'UN', quantity: 1,
    });

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    expandAllWithdrawalDateGroups();
    const rows = screen.getAllByTestId('withdrawal-history-row');
    expect(rows[0]).toHaveTextContent('REQ-2026-0002');
    expect(screen.getByRole('columnheader', { name: 'Último registro' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0002/i }));
    expect(screen.getAllByText(/registro:/i).length).toBeGreaterThan(0);
  });

  it('agrupa o histórico somente pelo prédio, sem separar os recebedores', () => {
    const project = projectWithMaterials(0);
    project.phases = [
      { id: 'building-a', name: 'Prédio A', color: '#000', tasks: [], order: 0 },
      { id: 'front-a', name: 'Frente A', color: '#000', tasks: [], parentId: 'building-a', order: 0 },
      { id: 'front-b', name: 'Frente B', color: '#000', tasks: [], parentId: 'building-a', order: 1 },
      { id: 'building-b', name: 'Prédio B', color: '#000', tasks: [], order: 1 },
    ];
    project.warehouse!.requisitions = [
      { id: 'req-a', number: 'REQ-2026-0001', date: '2026-08-21', status: 'entregue', chapterId: 'front-a', receiverName: 'Ana', createdAt: '2026-08-21T08:00:00.000Z', items: [{ itemKey: 'a', description: 'Item A', unit: 'UN', quantity: 1 }] },
      { id: 'req-b', number: 'REQ-2026-0002', date: '2026-08-21', status: 'entregue', chapterId: 'front-b', receiverName: 'Bia', createdAt: '2026-08-21T09:00:00.000Z', items: [{ itemKey: 'b', description: 'Item B', unit: 'UN', quantity: 2 }] },
      { id: 'req-legacy', number: 'REQ-2026-0003', date: '2026-08-21', status: 'entregue', receiverName: 'Caio', createdAt: '2026-08-21T10:00:00.000Z', items: [] },
      { id: 'req-old', number: 'REQ-2026-0004', date: '2026-08-20', status: 'entregue', chapterId: 'building-a', receiverName: 'Dani', createdAt: '2026-08-20T10:00:00.000Z', items: [] },
      { id: 'req-building-b', number: 'REQ-2026-0005', date: '2026-08-20', status: 'entregue', chapterId: 'building-b', receiverName: 'Elisa', createdAt: '2026-08-20T11:00:00.000Z', items: [] },
    ];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    const buildingRows = screen.getAllByTestId('withdrawal-building-group').filter(element => element.tagName === 'TR');
    expect(buildingRows).toHaveLength(3);
    expect(buildingRows[0]).toHaveTextContent('Prédio A');
    expect(buildingRows[0]).toHaveTextContent('3 requisição(ões) · 2 item(ns)');
    expect(buildingRows[1]).toHaveTextContent('Prédio B');
    expect(buildingRows[2]).toHaveTextContent('Prédio não informado');
    const dateRows = screen.getAllByTestId('withdrawal-date-group').filter(element => element.tagName === 'TR');
    expect(dateRows).toHaveLength(4);
    expect(dateRows[0]).toHaveTextContent('21/08/2026');
    expect(dateRows[0]).toHaveTextContent('2 requisição(ões) · 2 item(ns)');
    expect(screen.queryByTestId('withdrawal-history-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('withdrawal-destination-group')).not.toBeInTheDocument();

    expandAllWithdrawalDateGroups();
    const rows = screen.getAllByTestId('withdrawal-history-row');
    expect(rows[0]).toHaveTextContent('REQ-2026-0002');
    expect(rows[0]).toHaveTextContent('BIA');
    expect(rows[1]).toHaveTextContent('REQ-2026-0001');
    expect(rows[1]).toHaveTextContent('ANA');
    expect(rows[2]).toHaveTextContent('REQ-2026-0004');
    expect(rows[2]).toHaveTextContent('DANI');
    expect(rows[3]).toHaveTextContent('REQ-2026-0005');
    expect(rows[3]).toHaveTextContent('ELISA');
    expect(rows[4]).toHaveTextContent('REQ-2026-0003');
    expect(rows[4]).toHaveTextContent('CAIO');
  });

  it('usa a hierarquia completa da EAP no destino e preserva o fallback legado', () => {
    const project = projectWithMaterials(0);
    project.phases = [
      { id: 'root', name: 'Prédio', color: '#000', tasks: [], order: 0 },
      { id: 'system', name: 'Incêndio', color: '#000', tasks: [], parentId: 'root', order: 0 },
      { id: 'service', name: 'Hidrantes', color: '#000', tasks: [], parentId: 'system', order: 0 },
    ];
    project.warehouse!.requisitions = [
      {
        id: 'req-hierarchy', number: 'REQ-2026-0003', date: '2026-08-18', status: 'entregue', chapterId: 'service',
        receiverName: 'Ana', requesterName: 'Ana', signatureReceiver: 'assinatura', createdAt: '2026-08-18T10:00:00.000Z', items: [],
      },
      {
        id: 'req-legacy', number: 'REQ-2026-0004', date: '2026-08-17', status: 'entregue', chapterName: 'Destino legado',
        receiverName: 'Bia', requesterName: 'Bia', signatureReceiver: 'assinatura', createdAt: '2026-08-17', items: [],
      },
    ];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    expandAllWithdrawalDateGroups();
    expect(screen.getAllByText('1.1.1 · Prédio > Incêndio > Hidrantes').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Registro legado: 17\/08\/2026/).length).toBeGreaterThan(0);
  });

  it('move cautelas para a subaba Equipamentos / Cautelas', () => {
    const project = projectWithMaterials(0);
    project.warehouse!.custodyTerms = [{
      id: 'term-legacy', number: 'TC-2025-0001', createdAt: '2025-01-01T10:00:00.000Z', issuedAt: '2025-01-01',
      equipmentId: 'legacy-equipment', equipmentName: 'Furadeira antiga', workerName: 'Maria', status: 'em_uso',
    }];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    const equipmentTab = screen.getByRole('tab', { name: /Equipamentos \/ Cautelas/i });
    fireEvent.mouseDown(equipmentTab, { button: 0, ctrlKey: false });
    fireEvent.click(equipmentTab);

    expect(screen.getByRole('button', { name: /Nova cautela/i })).toBeInTheDocument();
    expect(screen.getAllByText('TC-2025-0001').length).toBeGreaterThan(0);
  });

  it('agrupa cautelas somente pelo prédio, mesmo com recebedores diferentes', () => {
    const project = projectWithMaterials(0);
    project.phases = [
      { id: 'building-a', name: 'Prédio A', color: '#000', tasks: [], order: 0 },
      { id: 'front-a', name: 'Frente A', color: '#000', tasks: [], parentId: 'building-a', order: 0 },
      { id: 'front-b', name: 'Frente B', color: '#000', tasks: [], parentId: 'building-a', order: 1 },
      { id: 'building-b', name: 'Prédio B', color: '#000', tasks: [], order: 1 },
    ];
    project.warehouse!.custodyTerms = [
      { id: 'term-a', number: 'TC-2026-0001', createdAt: '2026-08-20T10:00:00.000Z', issuedAt: '2026-08-20', equipmentId: 'eq-a', equipmentName: 'Furadeira', workerName: 'Ana', chapterId: 'front-a', chapterName: 'Frente A', status: 'em_uso' },
      { id: 'term-b', number: 'TC-2026-0002', createdAt: '2026-08-20T11:00:00.000Z', issuedAt: '2026-08-20', equipmentId: 'eq-b', equipmentName: 'Parafusadeira', workerName: 'Bia', chapterId: 'front-b', chapterName: 'Frente B', status: 'em_uso' },
      { id: 'term-c', number: 'TC-2026-0003', createdAt: '2026-08-20T12:00:00.000Z', issuedAt: '2026-08-20', equipmentId: 'eq-c', equipmentName: 'Esmerilhadeira', workerName: 'Caio', chapterId: 'building-b', chapterName: 'Prédio B', status: 'em_uso' },
    ];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    const equipmentTab = screen.getByRole('tab', { name: /Equipamentos \/ Cautelas/i });
    fireEvent.mouseDown(equipmentTab, { button: 0, ctrlKey: false });
    fireEvent.click(equipmentTab);

    const buildingRows = screen.getAllByTestId('custody-building-group').filter(element => element.tagName === 'TR');
    expect(buildingRows).toHaveLength(2);
    expect(buildingRows[0]).toHaveTextContent('Prédio A');
    expect(buildingRows[0]).toHaveTextContent('2 cautela(s) · 2 equipamento(s)');
    expect(buildingRows[1]).toHaveTextContent('Prédio B');
    expect(screen.getAllByText('Ana').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bia').length).toBeGreaterThan(0);
  });

  it('permite selecionar vários equipamentos disponíveis na mesma cautela', () => {
    const project = projectWithMaterials(0);
    project.warehouse!.equipments = [
      { id: 'eq-1', name: 'Furadeira', description: 'Furadeira', internalCode: 'EQ-001', serial: 'SER-001', status: 'disponivel', createdAt: '2026-08-18T10:00:00.000Z' },
      { id: 'eq-2', name: 'Parafusadeira', description: 'Parafusadeira', internalCode: 'EQ-002', patrimony: 'PAT-002', status: 'disponivel', createdAt: '2026-08-18T10:00:00.000Z' },
    ];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    const equipmentTab = screen.getByRole('tab', { name: /Equipamentos \/ Cautelas/i });
    fireEvent.mouseDown(equipmentTab, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('button', { name: /Nova cautela/i }));
    const available = screen.getByLabelText('Equipamentos disponíveis');
    const equipmentButtons = within(available).getAllByRole('button');
    fireEvent.click(equipmentButtons[0]);
    fireEvent.click(within(available).getAllByRole('button')[0]);

    expect(screen.getAllByLabelText('Estado na entrega')).toHaveLength(2);
    expect(within(available).queryAllByRole('button')).toHaveLength(0);
  });
});
