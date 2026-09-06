import { describe, expect, it } from 'vitest';
import { nextOperationalDate, operationalEndDate, scheduleWorkdayWeight } from './scheduleCalendar';

const baseCalendar = {
  uf: 'RO',
  municipio: 'Porto Velho',
  trabalhaSabado: false,
};

describe('exceções de expediente', () => {
  it('libera um sábado bloqueado como jornada integral', () => {
    const calendar = {
      ...baseCalendar,
      exceptions: [{ id: 'sat', date: '2026-09-05', reason: 'Concretagem', createdAt: '2026-09-01T12:00:00.000Z' }],
    };

    expect(scheduleWorkdayWeight(new Date(2026, 8, 5), calendar)).toBe(1);
    expect(operationalEndDate('2026-09-04', 2, calendar)).toBe('2026-09-05');
  });

  it('libera feriado como jornada integral e o usa na próxima data operacional', () => {
    const calendar = {
      ...baseCalendar,
      exceptions: [{ id: 'holiday', date: '2026-09-07', reason: 'Frente crítica', createdAt: '2026-09-01T12:00:00.000Z' }],
    };

    expect(scheduleWorkdayWeight(new Date(2026, 8, 7), calendar)).toBe(1);
    expect(nextOperationalDate('2026-09-07', calendar)).toBe('2026-09-07');
  });

  it('mantém domingo comum sem expediente', () => {
    expect(scheduleWorkdayWeight(new Date(2026, 8, 6), baseCalendar)).toBe(0);
    expect(nextOperationalDate('2026-09-06', baseCalendar)).toBe('2026-09-08');
  });
});
