import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { DailyReportHeader } from './DailyReportHeader';

const baseProps = {
  measurementFilter: 'all',
  setMeasurementFilter: vi.fn(),
  measurementPeriods: [],
  activePeriod: null,
  periodDates: [],
  selectedDate: '2026-09-13',
  setSelectedDate: vi.fn(),
  handlePrintDay: vi.fn(),
  handlePrintPeriod: vi.fn(),
};

describe('DailyReportHeader', () => {
  it('identifica a data operacional e mantém exportação como ação secundária', () => {
    const setSelectedDate = vi.fn();
    const handlePrintDay = vi.fn();

    render(
      <DailyReportHeader
        {...baseProps}
        setSelectedDate={setSelectedDate}
        handlePrintDay={handlePrintDay}
      />,
    );

    const date = screen.getByLabelText('Data do Diário');
    fireEvent.change(date, { target: { value: '2026-09-14' } });
    expect(setSelectedDate).toHaveBeenCalledWith('2026-09-14');

    const printDay = screen.getByRole('button', { name: 'PDF do dia' });
    expect(printDay).toHaveClass('border', 'bg-background');
    fireEvent.click(printDay);
    expect(handlePrintDay).toHaveBeenCalledOnce();
  });

  it('não transforma o PDF da medição na ação principal do Diário', () => {
    render(
      <DailyReportHeader
        {...baseProps}
        activePeriod={{ id: 'measurement-1', label: 'Medição 1', startDate: '2026-09-01', endDate: '2026-09-30' }}
        periodDates={['2026-09-13']}
      />,
    );

    expect(screen.getByRole('button', { name: 'PDF da medição' })).toHaveClass('border', 'bg-background');
  });
});
