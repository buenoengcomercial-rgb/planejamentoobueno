import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
