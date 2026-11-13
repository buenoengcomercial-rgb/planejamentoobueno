import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { custodyTermEquipmentItems, emptyWarehouse } from '@/lib/warehouse';
import type { CustodyTerm, Project } from '@/types/project';
import WarehouseCustodyTab from './WarehouseCustodyTab';
import WarehouseEquipmentsTab from './WarehouseEquipmentsTab';

function fixture(): Project {
  const term: CustodyTerm = {
    id: 'joao', number: 'TC-2026-0012', issuedAt: '2026-11-11', dueDate: '2026-11-20', createdAt: '2026-11-11',
    workerName: 'João da Silva', chapterId: 'front', equipmentId: 'drill', equipmentName: 'Furadeira', status: 'parcial',
    equipments: [
      { equipmentId: 'drill', equipmentName: 'Furadeira', status: 'em_uso' },
      { equipmentId: 'returned', equipmentName: 'Escada', status: 'devolvido' },
    ],
  };
  return {
    id: 'quick-return', name: 'Obra teste', startDate: '2026-01-01', endDate: '2026-12-31', totalBudget: 0,
    phases: [{ id: 'front', name: 'Prédio Sul', color: '#000', tasks: [] }],
    warehouse: {
      ...emptyWarehouse(),
      equipments: [{
        id: 'drill', name: 'Furadeira', description: 'Furadeira de impacto', internalCode: 'EQ-101',
        patrimony: 'PAT-23', serial: 'SER-456', status: 'em_uso', createdAt: '2026-11-11',
        photos: [{ id: 'photo', name: 'foto.png', kind: 'foto', uploadedAt: '2026-11-11', dataUrl: 'data:image/png;base64,Zm90bw==' }],
      }],
      custodyTerms: [
        term,
        { id: 'bia', number: 'TC-2026-0013', issuedAt: '2026-11-12', createdAt: '2026-11-12', workerName: 'Bia', equipmentId: 'legacy', equipmentName: 'Serra circular', equipmentInternalCode: 'EQ-ANTIGO', status: 'em_uso' },
      ],
    },
  };
}

const search = () => screen.getByRole('searchbox');

it('abre nas pendências e identifica responsáveis, inclusive em cautela legada sem cadastro', () => {
  render(<WarehouseCustodyTab project={fixture()} onProjectChange={vi.fn()} />);
  expect(screen.getByRole('tab', { name: 'Em uso / Pendentes de devolução' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('Com: João da Silva')).toBeVisible();
  expect(screen.getByText('Com: Bia')).toBeVisible();
  expect(screen.getByRole('img', { name: 'Foto de Furadeira de impacto' })).toBeVisible();
  expect(screen.getByText(/Prédio Sul/)).toBeVisible();
  expect(screen.getByText(/20\/11\/2026/)).toBeVisible();
  expect(screen.queryByText('Escada')).not.toBeInTheDocument();
});

it.each(['joao silva', 'furadeira de impacto', 'pat-23', 'eq-101', 'ser-456', 'tc-2026-0012'])('filtra imediatamente por %s', query => {
  render(<WarehouseCustodyTab project={fixture()} onProjectChange={vi.fn()} />);
  fireEvent.change(search(), { target: { value: query } });
  expect(screen.getByText('Com: João da Silva')).toBeVisible();
  expect(screen.queryByText('Com: Bia')).not.toBeInTheDocument();
});

it('mostra o resultado vazio e restaura todos os cards ao limpar', () => {
  render(<WarehouseCustodyTab project={fixture()} onProjectChange={vi.fn()} />);
  fireEvent.change(search(), { target: { value: 'inexistente' } });
  expect(screen.getByText('Nenhum equipamento em uso encontrado para este termo de busca')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Limpar busca' }));
  expect(search()).toHaveValue('');
  expect(screen.getByText('Com: Bia')).toBeVisible();
});

it.each([WarehouseCustodyTab, WarehouseEquipmentsTab])('abre a devolução correta e só retira a pendência após salvar', async Tab => {
  const initial = fixture();
  let confirmSave: () => void;
  const commit = vi.fn((next: Project, _domain: string, _base?: Project) => new Promise<Project>(resolve => {
    confirmSave = () => resolve(next);
  }));
  const fallback = vi.fn();
  function Harness() {
    const [project, setProject] = useState(initial);
    return <Tab project={project} onProjectChange={fallback} onCommitWarehouseScoped={async (next, domain, base) => {
      const accepted = await commit(next, domain, base);
      setProject(accepted);
      return accepted;
    }} />;
  }
  render(<Harness />);
  if (Tab === WarehouseEquipmentsTab) expect(screen.getByText(/Em uso por: João da Silva/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Devolver .*Furadeira/ }));
  const dialog = screen.getByRole('dialog', { name: 'Devolver equipamento' });
  expect(dialog).toHaveTextContent('TC-2026-0012');
  expect(dialog).toHaveTextContent('João da Silva');
  expect(dialog).toHaveTextContent('Furadeira');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar devolução' }));
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
  const [next, domain, base] = commit.mock.calls[0];
  expect(domain).toBe('custody');
  expect(base).toBe(initial);
  expect(custodyTermEquipmentItems(next.warehouse!.custodyTerms[0])[0].status).toBe('devolvido');
  expect(next.warehouse!.equipments[0].status).toBe('disponivel');
  expect(dialog).toBeVisible();
  confirmSave();
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: /Devolver .*Furadeira/ })).not.toBeInTheDocument();
  expect(fallback).not.toHaveBeenCalled();
});


it('exige ocorrência e foto para avaria e mantém os campos se a transação for recusada', async () => {
  const commit = vi.fn().mockRejectedValue(new Error('Devolução não confirmada'));
  render(<WarehouseCustodyTab project={fixture()} onProjectChange={vi.fn()} onCommitWarehouseScoped={commit} />);
  fireEvent.click(screen.getByRole('button', { name: /Devolver .*Furadeira/ }));
  const dialog = screen.getByRole('dialog', { name: 'Devolver equipamento' });
  const submit = () => fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar devolução' }));
  fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'danificado' } });
  submit();
  const note = within(dialog).getByLabelText('Descrição da ocorrência (obrigatória)');
  fireEvent.change(note, { target: { value: 'Carcaça quebrada' } });
  submit();
  expect(commit).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'devolvido' } });
  const condition = within(dialog).getByPlaceholderText('Condição observada');
  fireEvent.change(condition, { target: { value: 'Conferido no balcão' } });
  submit();
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
  expect(dialog).toBeVisible();
  expect(condition).toHaveValue('Conferido no balcão');
});
