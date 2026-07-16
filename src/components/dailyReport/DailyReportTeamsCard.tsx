import { Users, Plus, Trash2, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { DailyReport as DailyReportEntry, DailyReportTeamRow } from '@/types/project';
import type { TeamDefinition } from '@/lib/teams';

interface DailyReportTeamsCardProps {
  currentReport: DailyReportEntry;
  projectTeams: TeamDefinition[];
  teamByCode: Map<string, TeamDefinition>;
  teamDisplay: (def?: TeamDefinition, fallback?: string) => string;
  suggestedTeamCodes: string[];
  addTeamRow: (teamCode?: string) => void;
  updateTeamRow: (id: string, patch: Partial<DailyReportTeamRow>) => void;
  removeTeamRow: (id: string) => void;
  addSuggestedTeams: () => void;
}

export function DailyReportTeamsCard({
  currentReport,
  projectTeams,
  teamByCode,
  teamDisplay,
  suggestedTeamCodes,
  addTeamRow,
  updateTeamRow,
  removeTeamRow,
  addSuggestedTeams,
}: DailyReportTeamsCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="w-4 h-4 text-info" /> Equipe presente
        </CardTitle>
        <div className="flex items-center gap-1">
          {suggestedTeamCodes.length > 0 && (
            <Button size="sm" variant="ghost" onClick={addSuggestedTeams} title="Adiciona as equipes vinculadas às tarefas com produção no dia">
              <Activity className="w-3.5 h-3.5 mr-1" /> Sugerir do dia
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => addTeamRow()}>
            <Plus className="w-3.5 h-3.5 mr-1" /> Adicionar
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {(currentReport.teamsPresent || []).length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            Nenhuma equipe lançada.
            {suggestedTeamCodes.length > 0 && (
              <> Há {suggestedTeamCodes.length} equipe(s) com produção no dia — clique em <strong>Sugerir do dia</strong>.</>
            )}
          </p>
        )}
        {(currentReport.teamsPresent || []).map(t => (
          <div key={t.id} className="grid grid-cols-[minmax(0,1.6fr)_70px_minmax(0,1.4fr)_auto] gap-2 items-center">
            <Select
              value={t.teamCode || ''}
              onValueChange={(v) => {
                const def = teamByCode.get(v);
                updateTeamRow(t.id, { teamCode: v, name: def?.label || t.name, role: def?.composition || t.role });
              }}
            >
              <SelectTrigger className="h-10 text-sm">
                <SelectValue placeholder={teamDisplay(undefined, t.role || t.name) === '—' ? 'Selecionar equipe...' : teamDisplay(t.teamCode ? teamByCode.get(t.teamCode) : undefined, t.role || t.name)} />
              </SelectTrigger>
              <SelectContent>
                {projectTeams.map(team => (
                  <SelectItem key={team.code} value={team.code}>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-sm border"
                        style={{ backgroundColor: team.barColor, borderColor: team.borderColor }}
                      />
                      <span>{teamDisplay(team)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input type="number" min={0} placeholder="Qtd" value={t.count ?? ''}
              onChange={e => {
                const n = Number(e.target.value);
                updateTeamRow(t.id, { count: Number.isFinite(n) && n >= 0 ? n : 0 });
              }} />
            <Input placeholder="Observação" value={t.notes || ''}
              onChange={e => updateTeamRow(t.id, { notes: e.target.value })} />
            <Button size="icon" variant="ghost" onClick={() => removeTeamRow(t.id)}>
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
