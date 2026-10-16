import { act, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleProject } from '@/data/sampleProject';
import Dashboard from './Dashboard';

let releaseIdle: (() => void) | undefined;
beforeAll(async () => {
  // Compile the real chart module outside the UI wait. Under the full suite,
  // Vite's first transform competed with workers and exhausted findByText's deadline.
  // The test below still renders the actual charts and verifies deferred mounting.
  await import('./DashboardCharts');
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
    releaseIdle = callback;
    return 1;
  });
  vi.stubGlobal('cancelIdleCallback', () => {});
}, 20000);
afterAll(() => vi.unstubAllGlobals());

describe('Dashboard com gráficos sob demanda', () => {
  it('renderiza o conteúdo essencial e carrega os gráficos depois', async () => {
    render(<Dashboard project={sampleProject} />);

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Alertas prioritários')).toBeInTheDocument();
    expect(screen.queryByText('Progresso por Capítulo')).not.toBeInTheDocument();
    expect(releaseIdle).toBeTypeOf('function');
    await act(async () => releaseIdle!());
    expect(await screen.findByText('Progresso por Capítulo', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByText('Curva S - Planejado vs Realizado', {}, { timeout: 10_000 })).toBeInTheDocument();
  });
});
