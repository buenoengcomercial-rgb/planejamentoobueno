import type { DailyReport as DailyReportEntry, WeatherCondition, WorkCondition } from '@/types/project';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { WEATHER_OPTIONS, WORK_OPTIONS } from '@/components/dailyReport/dailyReportFormat';

interface DailyReportGeneralInfoProps {
  currentReport: DailyReportEntry;
  updateField: <K extends keyof DailyReportEntry>(key: K, value: DailyReportEntry[K]) => void;
}

export function DailyReportGeneralInfo({ currentReport, updateField }: DailyReportGeneralInfoProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Informações do dia</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Responsável pelo lançamento</Label>
            <Input
              value={currentReport.responsible || ''}
              onChange={e => updateField('responsible', e.target.value)}
              placeholder="Nome / função"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Clima</Label>
            <Select
              value={currentReport.weather || ''}
              onValueChange={(v) => {
                if (v === '__clear__') {
                  updateField('weather', undefined);
                  updateField('weatherOther', '');
                } else {
                  updateField('weather', v as WeatherCondition);
                }
              }}
            >
              <SelectTrigger><SelectValue placeholder="Selecionar..." /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__clear__">Sem seleção</SelectItem>
                {WEATHER_OPTIONS.map(o => {
                  const Icon = o.icon;
                  return (
                    <SelectItem key={o.value} value={o.value}>
                      <span className="inline-flex items-center gap-2">
                        <Icon className="w-3.5 h-3.5" /> {o.label}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {currentReport.weather === 'outro' && (
              <Input
                className="mt-1"
                placeholder="Descreva o clima"
                value={currentReport.weatherOther || ''}
                onChange={e => updateField('weatherOther', e.target.value)}
              />
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Condição de trabalho</Label>
            <Select
              value={currentReport.workCondition || ''}
              onValueChange={(v) => {
                if (v === '__clear__') {
                  updateField('workCondition', undefined);
                  updateField('workConditionOther', '');
                } else {
                  updateField('workCondition', v as WorkCondition);
                }
              }}
            >
              <SelectTrigger><SelectValue placeholder="Selecionar..." /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__clear__">Sem seleção</SelectItem>
                {WORK_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {currentReport.workCondition === 'outro' && (
              <Input
                className="mt-1"
                placeholder="Descreva a condição"
                value={currentReport.workConditionOther || ''}
                onChange={e => updateField('workConditionOther', e.target.value)}
              />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
