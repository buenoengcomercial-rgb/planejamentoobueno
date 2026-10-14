import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';

const mocks = vi.hoisted(() => ({ from: vi.fn(), repository: vi.fn() }));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner-1', email: 'owner@example.com', user_metadata: {} } }) }));
vi.mock('@/hooks/useOrganization', () => ({ useOrganization: () => ({ membership: { role: 'owner' } }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from } }));
vi.mock('@/lib/measurementCloudRepository', () => ({ cloudMeasurementRepository: mocks.repository }));
vi.mock('@/components/measurement/MeasurementWorkspace', () => ({ default: () => <p>Planilha incorporada</p> }));

import Measurement from './Measurement';

const project = { id: 'project-1', name: 'Obra de teste' } as Project;

beforeEach(() => {
  mocks.from.mockReset();
  mocks.repository.mockReset().mockReturnValue({ savedLabel: 'Salvo na nuvem' });
});
afterEach(() => vi.useRealTimers());

describe('abertura da Medição incorporada', () => {
  it('usa a confirmação recebida do carregamento da obra sem repetir a consulta', async () => {
    render(<Measurement project={project} independentConfirmed onProjectChange={vi.fn()} />);
    expect(await screen.findByText('Planilha incorporada')).toBeInTheDocument();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('confere a existência na nuvem ao entrar pela navegação sem confirmação prévia', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { project_id: project.id }, error: null });
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
    render(<Measurement project={project} onProjectChange={vi.fn()} />);
    expect(await screen.findByText('Planilha incorporada')).toBeInTheDocument();
    expect(mocks.from).toHaveBeenCalledWith('measurement_workspaces');
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('encerra a consulta suspensa após 30 segundos e permite repetir sem inferir outra base', async () => {
    vi.useFakeTimers();
    const maybeSingle = vi.fn().mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockResolvedValueOnce({ data: { project_id: project.id }, error: null });
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
    const onProjectChange = vi.fn(), onIndependentReady = vi.fn();
    render(<Measurement project={project} onProjectChange={onProjectChange} onIndependentReady={onIndependentReady} />);
    expect(screen.getByText('Conferindo a Medição na nuvem…')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível confirmar a base da Medição');
    expect(screen.queryByText('Conferindo a Medição na nuvem…')).not.toBeInTheDocument();
    expect(onIndependentReady).not.toHaveBeenCalled(); expect(onProjectChange).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' })); });
    expect(screen.getByText('Planilha incorporada')).toBeInTheDocument();
    expect(maybeSingle).toHaveBeenCalledTimes(2);
    expect(onIndependentReady).toHaveBeenCalledWith(project.id);
    expect(onProjectChange).not.toHaveBeenCalled();
  });

  it('ignora a resposta antiga depois do prazo enquanto a repetição ainda está pendente', async () => {
    vi.useFakeTimers();
    type Receipt = { data: { project_id: string }; error: null };
    let resolveOld!: (receipt: Receipt) => void, resolveCurrent!: (receipt: Receipt) => void;
    const maybeSingle = vi.fn().mockReturnValueOnce(new Promise<Receipt>(done => { resolveOld = done; }))
      .mockReturnValueOnce(new Promise<Receipt>(done => { resolveCurrent = done; }));
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
    const onIndependentReady = vi.fn();
    render(<Measurement project={project} onProjectChange={vi.fn()} onIndependentReady={onIndependentReady} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' })); });
    await act(async () => { resolveOld({ data: { project_id: project.id }, error: null }); });
    expect(screen.getByText('Conferindo a Medição na nuvem…')).toBeInTheDocument();
    expect(screen.queryByText('Planilha incorporada')).not.toBeInTheDocument();
    expect(onIndependentReady).not.toHaveBeenCalled();
    await act(async () => { resolveCurrent({ data: { project_id: project.id }, error: null }); });
    expect(screen.getByText('Planilha incorporada')).toBeInTheDocument();
    expect(onIndependentReady).toHaveBeenCalledTimes(1);
  });

  it('apresenta erro recuperável quando a consulta rejeita por transporte', async () => {
    const maybeSingle = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
    const onIndependentReady = vi.fn(), onProjectChange = vi.fn();
    render(<Measurement project={project} onProjectChange={onProjectChange} onIndependentReady={onIndependentReady} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível confirmar a base da Medição');
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeEnabled();
    expect(screen.queryByText('Planilha incorporada')).not.toBeInTheDocument();
    expect(onIndependentReady).not.toHaveBeenCalled(); expect(onProjectChange).not.toHaveBeenCalled();
  });

  it('não mantém a planilha anterior quando a confirmação é revogada', async () => {
    const maybeSingle = vi.fn(() => new Promise<never>(() => undefined));
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
    const { rerender } = render(<Measurement project={project} independentConfirmed onProjectChange={vi.fn()} />);
    expect(await screen.findByText('Planilha incorporada')).toBeInTheDocument();

    rerender(<Measurement project={project} onProjectChange={vi.fn()} />);
    expect(screen.queryByText('Planilha incorporada')).not.toBeInTheDocument();
    expect(screen.getByText('Conferindo a Medição na nuvem…')).toBeInTheDocument();
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('volta a conferir a base ao trocar entre obras sem confirmação prévia', async () => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: { project_id: project.id }, error: null })
      .mockImplementationOnce(() => new Promise<never>(() => undefined));
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
    const { rerender } = render(<Measurement project={project} onProjectChange={vi.fn()} />);
    expect(await screen.findByText('Planilha incorporada')).toBeInTheDocument();

    rerender(<Measurement project={{ ...project, id: 'project-2' }} onProjectChange={vi.fn()} />);
    expect(screen.queryByText('Planilha incorporada')).not.toBeInTheDocument();
    expect(screen.getByText('Conferindo a Medição na nuvem…')).toBeInTheDocument();
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });
});
