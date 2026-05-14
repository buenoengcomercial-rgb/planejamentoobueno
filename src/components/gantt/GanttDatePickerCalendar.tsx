import { useEffect, useState } from 'react';
import { ptBR } from 'date-fns/locale';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';

interface Props {
  valueDate?: Date;
  onSelect: (d: Date | undefined) => void;
  title?: string;
}

export function GanttDatePickerCalendar({ valueDate, onSelect, title }: Props) {
  const [month, setMonth] = useState<Date>(valueDate ?? new Date());

  useEffect(() => {
    if (valueDate) setMonth(valueDate);
  }, [valueDate?.getTime()]);

  return (
    <div>
      {title && (
        <div className="px-3 pt-2 pb-1 text-xs font-semibold text-foreground border-b">
          {title}
        </div>
      )}
      <Calendar
        mode="single"
        selected={valueDate}
        month={month}
        onMonthChange={setMonth}
        onSelect={onSelect}
        locale={ptBR}
        weekStartsOn={0}
        className={cn('p-3 pointer-events-auto')}
      />
    </div>
  );
}
