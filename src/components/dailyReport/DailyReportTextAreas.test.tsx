import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DailyReport } from '@/types/project';
import { DailyReportTextAreas } from './DailyReportTextAreas';

const report = {
  id: 'daily-1',
  date: '2026-08-24',
  teamsPresent: [],
  equipment: [],
  attachments: [],
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
} as DailyReport;

describe('DailyReportTextAreas', () => {
  it('mantém a digitação local até o usuário sair do campo', () => {
    const updateField = vi.fn();
    render(<DailyReportTextAreas currentReport={report} updateField={updateField} />);

    const observations = screen.getByPlaceholderText('Notas adicionais...');
    fireEvent.change(observations, { target: { value: 'I' } });
    fireEvent.change(observations, { target: { value: 'In' } });
    fireEvent.change(observations, { target: { value: 'Início da obra' } });

    expect(updateField).not.toHaveBeenCalled();
    expect(observations).toHaveValue('Início da obra');
  });

  it('persiste imediatamente ao sair do campo', () => {
    const updateField = vi.fn();
    render(<DailyReportTextAreas currentReport={report} updateField={updateField} />);

    const observations = screen.getByPlaceholderText('Notas adicionais...');
    fireEvent.change(observations, { target: { value: 'Registro concluído' } });
    fireEvent.blur(observations);

    expect(updateField).toHaveBeenCalledTimes(1);
    expect(updateField).toHaveBeenCalledWith('observations', 'Registro concluído');
  });
});
