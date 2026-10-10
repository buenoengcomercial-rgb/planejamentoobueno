import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DailyProductionLog } from '@/types/project';
import ProductionMeasurementPanel from './ProductionMeasurementPanel';

describe('apresentação dos lançamentos antigos em Produção por medição', () => {
  it('encaminha todos os lançamentos ao detalhe, conta uma vez e respeita bloqueios', () => {
    const renderDetail = vi.fn((log: DailyProductionLog, _readOnly: boolean, _period: boolean) => <span>{log.id}</span>);
    render(<ProductionMeasurementPanel unit="un" readOnly={false} onBegin={vi.fn()} renderDetail={renderDetail} logs={[
      { id: 'old-a', date: '2026-09-20', actualQuantity: 221, plannedQuantity: 0 },
      { id: 'old-b', date: '2026-09-21', actualQuantity: 3, plannedQuantity: 0 },
      { id: 'period', date: '', actualQuantity: 4, plannedQuantity: 0, measurementPeriod: { number: 1, startDate: '2026-08-24', endDate: '2026-09-22' } },
      { id: 'outside', date: '2026-08-01', actualQuantity: 2, plannedQuantity: 0 },
    ]} periods={[
      { key: 'first', number: 1, startDate: '2026-08-24', endDate: '2026-09-22' },
      { key: 'overlap', number: 2, startDate: '2026-09-20', endDate: '2026-10-22', blockedReason: 'Sobreposição: somente consulta.' },
    ]} />);
    expect(screen.getByLabelText('Total da 1ª medição')).toHaveTextContent('228 un');
    expect(screen.getByLabelText('Total da 2ª medição')).toHaveTextContent('0 un');
    expect(renderDetail.mock.calls.map(([log, readOnly]) => [log.id, readOnly])).toEqual([['old-a', false], ['old-b', false], ['period', false], ['outside', false]]);
    expect(screen.queryByText(/Histórico preservado/)).not.toBeInTheDocument();
  });
  it('exibe o detalhe antigo em consulta em medição fiscal e referências a período ausente', () => {
    const renderDetail = vi.fn((log: DailyProductionLog, _readOnly: boolean, _period: boolean) => <span>{log.id}</span>);
    render(<ProductionMeasurementPanel unit="un" readOnly={false} onBegin={vi.fn()} renderDetail={renderDetail} logs={[
      { id: 'old', date: '2026-09-21', actualQuantity: 221, plannedQuantity: 0 },
      { id: 'missing', date: '', actualQuantity: 4, plannedQuantity: 0, measurementPeriod: { number: 9, startDate: '2026-08-24', endDate: '2026-09-22' } },
    ]} periods={[{ key: 'first', number: 1, startDate: '2026-08-24', endDate: '2026-09-22', blockedReason: 'Medição aprovada.' }]} />);
    expect(renderDetail.mock.calls.map(([log, readOnly]) => [log.id, readOnly])).toEqual([['old', true], ['missing', true]]);
    expect(screen.queryByRole('button', { name: /Adicionar quantitativo/ })).not.toBeInTheDocument();
  });
});
