import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { DailyReportHeader } from './DailyReportHeader';

const baseProps = {
  setMeasurementFilter: vi.fn(),
  measurementPeriods: [],
  activePeriod: null,
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

  it('mantém qualquer data acessível mesmo com uma medição selecionada', () => {
    const setSelectedDate = vi.fn();
    render(
      <DailyReportHeader
        {...baseProps}
        activePeriod={{ id: 'measurement-1', label: 'Medição 1', startDate: '2026-09-01', endDate: '2026-09-30' }}
        setSelectedDate={setSelectedDate}
      />,
    );

    fireEvent.change(screen.getByLabelText('Data do Diário'), { target: { value: '2026-10-10' } });
    expect(setSelectedDate).toHaveBeenCalledWith('2026-10-10');
    expect(screen.getByRole('button', { name: 'PDF da medição' })).toHaveClass('border', 'bg-background');
  });

  it('mostra a medição resolvida quando o atalho ainda usa o identificador antigo', () => {
    const resolved = {
      id: 'draft:1:2026-08-24:2026-09-22',
      number: 1,
      label: 'Medição Nº 1',
      startDate: '2026-08-24',
      endDate: '2026-09-29',
    };
    render(<DailyReportHeader {...baseProps} measurementPeriods={[resolved]} activePeriod={resolved} />);

    expect(screen.getByRole('combobox')).toHaveTextContent('Medição Nº 1');
  });
});
