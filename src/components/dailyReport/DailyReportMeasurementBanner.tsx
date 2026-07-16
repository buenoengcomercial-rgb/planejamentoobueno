import { FileText } from 'lucide-react';
import type { DateMembership } from '@/hooks/useDailyReportPeriods';

interface DailyReportMeasurementBannerProps {
  dateMembership: DateMembership;
}

export function DailyReportMeasurementBanner({ dateMembership }: DailyReportMeasurementBannerProps) {
  if (!dateMembership) return null;
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm flex items-center gap-2 ${
      dateMembership.kind === 'generated'
        ? 'border-info/40 bg-info/10 text-info'
        : 'border-warning/40 bg-warning/10 text-warning'
    }`}>
      <FileText className="w-4 h-4" />
      <span>
        {dateMembership.kind === 'generated'
          ? <>Este diário faz parte da <strong>{dateMembership.label}</strong>.</>
          : <>Este diário está dentro do período da <strong>{dateMembership.label}</strong>.</>}
      </span>
    </div>
  );
}
