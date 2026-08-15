import type { DailyReport as DailyReportEntry, WeatherCondition, WorkCondition } from '@/types/project';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { WEATHER_OPTIONS, WORK_OPTIONS } from '@/components/dailyReport/dailyReportFormat';
import { Switch } from '@/components/ui/switch';
import { Ban } from 'lucide-react';

interface DailyReportGeneralInfoProps {
  currentReport: DailyReportEntry;
  updateField: <K extends keyof DailyReportEntry>(key: K, value: DailyReportEntry[K]) => void;
  onClearDay: () => void;
  hasProduction?: boolean;
}

export function DailyReportGeneralInfo({ currentReport, updateField, onClearDay, hasProduction = false }: DailyReportGeneralInfoProps) {
  const { confirm, dialog: confirmDialog } = useConfirmDelete();

  const handleClearDay = () => {
    confirm(
      {
        title: 'Limpar diário deste dia?',
        description: (
          <p>
            Isso removerá equipes, equipamentos, observações e fotos vinculadas a este dia.
          </p>
        ),
        confirmLabel: 'Limpar diário',
      },
      onClearDay,
    );
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Informações do dia</CardTitle>
          <Button size="sm" variant="ghost" onClick={handleClearDay} className="h-9 text-sm">
            <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Limpar diário do dia
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <Ban className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div>
                <Label htmlFor="no-production-declared" className="text-sm font-semibold">Declarar dia sem produção</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Use somente quando nenhuma atividade foi executada. Ausência de diário continuará como “Não preenchido”.
                </p>
              </div>
            </div>
            <Switch
              id="no-production-declared"
              checked={!!currentReport.noProductionDeclared}
              disabled={hasProduction}
              onCheckedChange={checked => updateField('noProductionDeclared', checked || undefined)}
              aria-label="Declarar dia sem produção"
            />
          </div>
          {hasProduction && (
            <p className="text-xs text-warning">Há produção apontada nesta data; a declaração de dia sem produção está indisponível.</p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-sm">Responsável pelo lançamento</Label>
              <Input
                value={currentReport.responsible || ''}
                onChange={e => updateField('responsible', e.target.value)}
                placeholder="Nome / função"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Clima</Label>
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
                <SelectTrigger className="h-10 text-sm"><SelectValue placeholder="Selecionar..." /></SelectTrigger>
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
              <Label className="text-sm">Condição de trabalho</Label>
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
                <SelectTrigger className="h-10 text-sm"><SelectValue placeholder="Selecionar..." /></SelectTrigger>
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
      {confirmDialog}
    </>
  );
}
