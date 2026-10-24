import { act, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleProject } from '@/data/sampleProject';
import { generateCurvaS } from '@/lib/calculations';
import Dashboard from './Dashboard';

vi.mock('@/lib/calculations', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/calculations')>();
  return { ...actual, generateCurvaS: vi.fn(actual.generateCurvaS) };
});

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
    vi.mocked(generateCurvaS).mockClear();
    const { rerender } = render(<Dashboard project={sampleProject} />);

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Alertas prioritários')).toBeInTheDocument();
    expect(screen.queryByText('Progresso por Capítulo')).not.toBeInTheDocument();
    expect(generateCurvaS).not.toHaveBeenCalled();
    expect(releaseIdle).toBeTypeOf('function');
    await act(async () => releaseIdle!());
    expect(generateCurvaS).toHaveBeenCalledExactlyOnceWith(sampleProject);
    expect(await screen.findByText('Progresso por Capítulo', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByText('Curva S - Planejado vs Realizado', {}, { timeout: 10_000 })).toBeInTheDocument();
    rerender(<Dashboard project={sampleProject} />);
    expect(generateCurvaS).toHaveBeenCalledTimes(1);
  });

  it('usa a obra atual se a seleção mudar antes de carregar os gráficos', async () => {
    vi.mocked(generateCurvaS).mockClear();
    const outraObra = { ...sampleProject, id: 'proj-002', name: 'Outra obra' };
    const { rerender } = render(<Dashboard project={sampleProject} />);
    rerender(<Dashboard project={outraObra} />);

    expect(screen.getByText('Outra obra')).toBeInTheDocument();
    expect(generateCurvaS).not.toHaveBeenCalled();

    await act(async () => releaseIdle!());
    expect(generateCurvaS).toHaveBeenCalledExactlyOnceWith(outraObra);
  });
});
