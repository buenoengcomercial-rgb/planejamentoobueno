import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleProject } from '@/data/sampleProject';
import Dashboard from './Dashboard';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
    callback();
    return 1;
  });
  vi.stubGlobal('cancelIdleCallback', () => {});
});

describe('Dashboard com gráficos sob demanda', () => {
  it('renderiza o conteúdo essencial e carrega os gráficos depois', async () => {
    render(<Dashboard project={sampleProject} />);

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Alertas prioritários')).toBeInTheDocument();
    expect(await screen.findByText('Progresso por Capítulo', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByText('Curva S - Planejado vs Realizado', {}, { timeout: 10_000 })).toBeInTheDocument();
  });
});
