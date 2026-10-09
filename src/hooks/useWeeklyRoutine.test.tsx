import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { useWeeklyRoutine } from './useWeeklyRoutine';

const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { workers.push(this); }
}
const project = { id: 'fictional', phases: [], dailyReports: [] } as unknown as Project;
const excluded = new Set<string>();
const calendar = { uf: 'RO', municipio: 'Porto Velho', trabalhaSabado: true };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); workers.length = 0; });
describe('weekly calculation worker', () => {
  it('preserves the complete routine if the browser cannot load module workers', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { result } = renderHook(() => useWeeklyRoutine(project, '2026-10-05', excluded, calendar));
    await act(async () => workers[0].onerror?.());
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.week.some(day => day.date === '2026-10-05')).toBe(true);
    expect(workers[0].terminate).toHaveBeenCalled();
  });
  it('sends complete inputs and rejects late results from the previous project', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { result, rerender } = renderHook(({ value }) => useWeeklyRoutine(value, '2026-10-05', excluded, calendar), { initialProps: { value: project } });
    expect(result.current.loading).toBe(true);
    expect(workers[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({ project, calendar, excludedTaskIds: excluded }));
    const previous = workers[0];
    rerender({ value: { ...project, id: 'other' } });
    act(() => previous.onmessage?.({ data: { week: [{ date: 'stale' }] } }));
    expect(result.current.loading).toBe(true);
    act(() => workers[1].onmessage?.({ data: { week: [{ date: '2026-10-05', activities: [] }] } }));
    expect(result.current.week[0].date).toBe('2026-10-05');
    expect(result.current.loading).toBe(false);
    expect(previous.terminate).toHaveBeenCalled();
  });
  it('offers retry on a stalled worker instead of infinite loading', () => {
    vi.useFakeTimers(); vi.stubGlobal('Worker', FakeWorker);
    const { result } = renderHook(() => useWeeklyRoutine(project, '2026-10-05', excluded, calendar));
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.error).toContain('Tente novamente');
    expect(result.current.loading).toBe(false);
    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    expect(workers).toHaveLength(2);
  });
});
