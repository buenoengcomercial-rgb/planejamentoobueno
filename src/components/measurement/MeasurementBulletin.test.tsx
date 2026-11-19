import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import MeasurementBulletin from './MeasurementBulletin';
import type { MeasurementWorkspace } from '@/lib/measurementWorkspace';

const workspace = {
  schema: 1, projectId: 'p', projectName: 'Obra', revision: 1, services: [], entries: [], plans: [], audit: [],
  importedKeys: [], backupId: 'backup', contract: { bdiPercent: 25 },
  periods: [{ id: 'm1', number: 1, startDate: '2026-11-01', endDate: '2026-11-30', status: 'draft' }],
} as MeasurementWorkspace;
afterEach(() => vi.useRealTimers());

it('agrupa as teclas e envia ao sair do campo ou após a pausa de digitação', async () => {
  vi.useFakeTimers();
  const onCommit = vi.fn(async () => true);
  render(<MeasurementBulletin workspace={workspace} measurementId="m1" readOnly={false} drafts={[]}
    onDraft={async () => undefined} onCommit={onCommit} />);
  const field = screen.getByLabelText('Nº da ART');
  for (const value of ['A', 'AR', 'ART']) fireEvent.change(field, { target: { value } });
  expect(onCommit).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit.mock.calls[0][0]).toEqual(['artNumber']);
  expect(onCommit.mock.calls[0][1]).toEqual({ contract: { artNumber: 'ART' } });
  fireEvent.blur(field);
  await act(async () => undefined);
  expect(onCommit).toHaveBeenCalledTimes(1);
});

it('mantém uma gravação em voo e envia só o último texto digitado durante a confirmação', async () => {
  let finish: (saved: boolean) => void = () => undefined;
  const onCommit = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  render(<MeasurementBulletin workspace={workspace} measurementId="m1" readOnly={false} drafts={[]}
    onDraft={async () => undefined} onCommit={onCommit} />);
  const field = screen.getByLabelText('Nº da ART');
  fireEvent.change(field, { target: { value: 'A' } }); fireEvent.blur(field);
  for (const value of ['AR', 'ART', 'ART final']) {
    fireEvent.change(field, { target: { value } }); fireEvent.blur(field);
  }
  expect(onCommit).toHaveBeenCalledTimes(1);
  await act(async () => { finish(true); });
  await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
  expect(onCommit.mock.calls[1][1]).toEqual({ contract: { artNumber: 'ART final' } });
  await act(async () => { finish(true); });
  expect(screen.queryByText('Enviando alterações do boletim à nuvem…')).not.toBeInTheDocument();
});
