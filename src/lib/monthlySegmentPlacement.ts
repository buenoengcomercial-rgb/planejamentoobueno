import type { OperationalScheduleSegment, Project } from '@/types/project';
import { nextOperationalDate, operationalEndDate, parseScheduleDate, scheduleDateISO, scheduleWorkdayWeight } from './scheduleCalendar';

const EPSILON = 1e-8;
type MonthlyWork = { allocations: Record<string, number>; balance: number };
const roundQuantity = (value: number) => Number(value.toFixed(8));

function nextDay(day: string) {
  const date = parseScheduleDate(day);
  date.setDate(date.getDate() + 1);
  return scheduleDateISO(date);
}

function nextMonth(day: string) {
  const date = parseScheduleDate(day);
  date.setMonth(date.getMonth() + 1, 1);
  return scheduleDateISO(date);
}

function capacityFrom(start: string, calendar: NonNullable<Project['scheduleCalendar']>) {
  let capacity = 0;
  const end = nextMonth(start);
  for (let date = start; date < end; date = nextDay(date)) capacity += scheduleWorkdayWeight(parseScheduleDate(date), calendar);
  return capacity;
}

export function placeWork(work: MonthlyWork, duration: number, start: string, calendar: NonNullable<Project['scheduleCalendar']>) {
  const portions = Object.entries(work.allocations).sort();
  const unassigned = roundQuantity(work.balance - portions.reduce((sum, [, amount]) => sum + amount, 0));
  // The undistributed balance still consumes operational time for successors.
  if (unassigned > EPSILON) portions.push(['', unassigned]);
  const segments: OperationalScheduleSegment[] = [];
  let day = nextOperationalDate(start, calendar);
  for (const [month, quantity] of portions) {
    if (month && day < `${month}-01`) day = nextOperationalDate(`${month}-01`, calendar);
    let rest = duration * quantity / work.balance;
    let remainingQuantity = quantity;
    for (let attempt = 0; rest > EPSILON && attempt < 600; attempt++) {
      const available = capacityFrom(day, calendar);
      const wholeMonthCapacity = capacityFrom(`${day.slice(0, 7)}-01`, calendar);
      if (available < rest - EPSILON && available < wholeMonthCapacity - EPSILON && month) {
        day = nextOperationalDate(nextMonth(day), calendar);
        continue;
      }
      const days = Math.min(available, rest);
      if (days <= EPSILON) {
        day = nextOperationalDate(nextMonth(day), calendar);
        continue;
      }
      const finish = operationalEndDate(day, days, calendar);
      const placed = days >= rest - EPSILON ? remainingQuantity : roundQuantity(quantity * days / (duration * quantity / work.balance));
      segments.push({ startDate: day, endDate: finish, duration: days, quantity: placed });
      day = nextOperationalDate(nextDay(finish), calendar);
      rest -= days;
      remainingQuantity = roundQuantity(remainingQuantity - placed);
    }
    if (rest > EPSILON) throw Error('A parcela não cabe no calendário operacional.');
  }
  return segments;
}

