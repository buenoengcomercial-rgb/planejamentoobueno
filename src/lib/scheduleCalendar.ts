import { isDiaUtil } from '@/lib/feriados';

/** Calendário operacional compartilhado por Cronograma, Rotina e reprogramação. */
export interface ScheduleCalendar {
  uf: string;
  municipio: string;
  trabalhaSabado: boolean;
}

export function parseScheduleDate(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function scheduleDateISO(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function scheduleWorkdayWeight(date: Date, calendar: ScheduleCalendar): number {
  if (!isDiaUtil(date, calendar.uf, calendar.municipio, calendar.trabalhaSabado)) return 0;
  return date.getDay() === 6 ? 0.5 : 1;
}

/** Ajusta uma data escolhida para o próximo dia com expediente. */
export function nextOperationalDate(dateISO: string, calendar: ScheduleCalendar): string {
  const date = parseScheduleDate(dateISO);
  let safety = 0;
  while (safety++ < 10_000) {
    if (scheduleWorkdayWeight(date, calendar) > 0) return scheduleDateISO(date);
    date.setDate(date.getDate() + 1);
  }
  return dateISO;
}

/** Último dia operacional necessário para consumir a duração informada. */
export function operationalEndDate(startDateISO: string, duration: number, calendar: ScheduleCalendar): string {
  const date = parseScheduleDate(nextOperationalDate(startDateISO, calendar));
  let remaining = Math.max(0.5, Number(duration) || 1);
  let safety = 0;
  while (safety++ < 10_000) {
    const capacity = scheduleWorkdayWeight(date, calendar);
    if (capacity > 0) {
      remaining -= capacity;
      if (remaining <= 0) return scheduleDateISO(date);
    }
    date.setDate(date.getDate() + 1);
  }
  return startDateISO;
}

/** Dias operacionais transcorridos após o início e até a nova data, inclusive. */
export function operationalDelayDuration(currentStartDate: string, proposedStartDate: string, calendar: ScheduleCalendar): number {
  if (proposedStartDate <= currentStartDate) return 0;
  const date = parseScheduleDate(currentStartDate);
  let delay = 0;
  let safety = 0;
  while (safety++ < 10_000) {
    date.setDate(date.getDate() + 1);
    const key = scheduleDateISO(date);
    if (key > proposedStartDate) return delay;
    delay += scheduleWorkdayWeight(date, calendar);
  }
  return delay;
}
