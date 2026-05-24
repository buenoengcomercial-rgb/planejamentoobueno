import { useMemo, useState } from 'react';
import type { ElementType } from 'react';
import { AlertTriangle, BarChart3, CheckCircle2, ClipboardCheck, Gauge, RefreshCw, Users, Zap } from 'lucide-react';
import type { LaborNormalizationType, Project } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  buildLaborProjection,
  getDimensioningSettings,
  getLaborAvailability,
  getOperationalRoles,
  saveManualNormalization,
  updateAvailability,
} from '@/lib/laborDimensioning';

interface Props {
  project: Project;
  onProjectChange: (next: Project | ((prev: Project) => Project)) => void;
}

function fmtHours(value: number) {
  return `${Math.round(value).toLocaleString('pt-BR')} h`;
}

function fmtPeople(value: number) {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

function pct(value: number, max: number) {
  if (max <= 0) return 0;
  return Math.max(4, Math.min(100, (value / max) * 100));
}

export default function LaborDimensioning({ project, onProjectChange }: Props) {
  const [normalizedAt, setNormalizedAt] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<string>('todos');
  const projection = useMemo(() => buildLaborProjection(project), [project]);
  const roles = useMemo(() => getOperationalRoles(project), [project]);
  const availability = useMemo(() => getLaborAvailability(project), [project]);
  const settings = useMemo(() => getDimensioningSettings(project), [project]);

  const maxMonthlyPeople = Math.max(1, ...projection.periodRows.map(row => row.recommendedPeople));
  const maxRoleHours = Math.max(1, ...projection.summaries.map(row => row.hours));
  const noTeam = projection.compatibility.filter(row => row.reason === 'sem_equipe');
  const incompatible = projection.compatibility.filter(row => row.reason === 'faltando_cargo');
  const actionableTasks = projection.taskSummaries.filter(row => row.status !== 'ok');

  const normalizationGroups = useMemo(() => {
    const map = new Map<string, {
      originalRole: string;
      normalizedRoleId?: string;
      normalizedRoleName?: string;
      normalizationType: LaborNormalizationType;
      hours: number;
      count: number;
      automaticRuleApplied?: string;
    }>();
    projection.lines.forEach(line => {
      const key = line.originalRole.trim().toLowerCase();
      const current = map.get(key) ?? {
        originalRole: line.originalRole,
        normalizedRoleId: line.normalizedRoleId,
        normalizedRoleName: line.normalizedRoleName,
        normalizationType: line.normalizationType,
        hours: 0,
        count: 0,
        automaticRuleApplied: line.automaticRuleApplied,
      };
      current.hours += line.hours;
      current.count += 1;
      map.set(key, current);
    });
    return Array.from(map.values()).sort((a, b) => b.hours - a.hours);
  }, [projection.lines]);

  const filteredPeriods = selectedRole === 'todos'
    ? projection.periodRows
    : projection.periodRows.filter(row => row.roleId === selectedRole);

  const applyAvailability = (roleId: string, patch: { quantity?: number; dailyHours?: number; hourlyCost?: number }) => {
    onProjectChange(prev => updateAvailability(prev, roleId, patch));
  };

  const saveNormalization = (originalName: string, type: LaborNormalizationType, roleId?: string) => {
    onProjectChange(prev => saveManualNormalization(prev, originalName, type, roleId));
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
        <MetricCard icon={Gauge} label="Horas de mao de obra" value={fmtHours(projection.totalHours)} desc="Somatorio por RUP" />
        <MetricCard icon={Users} label="Pico de pessoas" value={projection.peakPeople} desc={projection.peakPeriod} tone={projection.peakPeople > 0 ? 'primary' : 'muted'} />
        <MetricCard icon={AlertTriangle} label="Cargos em deficit" value={projection.deficitRoles} desc="Disponivel menor que necessario" tone={projection.deficitRoles ? 'warning' : 'success'} />
        <MetricCard icon={Zap} label="Equipe incompativel" value={incompatible.length} desc="Equipe escolhida nao atende a RUP" tone={incompatible.length ? 'warning' : 'success'} />
        <MetricCard icon={AlertTriangle} label="Revisar manualmente" value={projection.reviewCount} desc="Sem regra confiavel" tone={projection.reviewCount ? 'warning' : 'success'} />
        <MetricCard icon={CheckCircle2} label="Sem equipe definida" value={noTeam.length} desc="Tarefas com RUP, mas sem equipe" tone={noTeam.length ? 'warning' : 'muted'} />
      </div>

      <section className="rounded-xl border border-primary/20 bg-primary/5 p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
            <ClipboardCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-foreground">Como usar este painel na obra</h2>
            <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-muted-foreground md:grid-cols-4">
              <div><strong className="text-foreground">1. Normalizar</strong><br />Conferir se os insumos viraram cargos corretos.</div>
              <div><strong className="text-foreground">2. Informar disponivel</strong><br />Preencher quantas pessoas existem na obra.</div>
              <div><strong className="text-foreground">3. Ver gargalos</strong><br />Olhar capitulos e tarefas que exigem reforco.</div>
              <div><strong className="text-foreground">4. Ajustar execucao</strong><br />Voltar para Producao/Cronograma e escolher equipe compativel.</div>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-foreground">Normalizacao de mao de obra</h2>
            <p className="text-xs text-muted-foreground">
              Preserva o insumo original e cria somente a leitura executiva para equipe, histograma e gargalo.
            </p>
          </div>
          <Button size="sm" onClick={() => setNormalizedAt(new Date().toLocaleString('pt-BR'))}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Normalizar mao de obra
          </Button>
        </div>

        {normalizedAt && (
          <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">
            Normalizacao recalculada em {normalizedAt}: {normalizationGroups.length} grupos de insumo, {projection.reviewCount} pendencia(s) para revisao.
          </div>
        )}

        <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                <th className="p-2 text-left">Insumo original</th>
                <th className="p-2 text-left">Cargo normalizado</th>
                <th className="p-2 text-right">Horas</th>
                <th className="p-2 text-left">Regra</th>
              </tr>
            </thead>
            <tbody>
              {normalizationGroups.slice(0, 60).map(row => (
                <tr key={row.originalRole} className="border-t border-border">
                  <td className="p-2 font-medium text-foreground">{row.originalRole}</td>
                  <td className="p-2">
                    <select
                      value={row.normalizationType === 'cargo_operacional' ? (row.normalizedRoleId ?? '') : row.normalizationType}
                      onChange={event => {
                        const value = event.target.value;
                        if (value === 'custo_acessorio' || value === 'ignorar_no_dimensionamento' || value === 'revisar_manualmente') {
                          saveNormalization(row.originalRole, value);
                        } else {
                          saveNormalization(row.originalRole, 'cargo_operacional', value);
                        }
                      }}
                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    >
                      <option value="revisar_manualmente">Revisar manualmente</option>
                      <option value="custo_acessorio">Custo acessorio</option>
                      <option value="ignorar_no_dimensionamento">Ignorar no dimensionamento</option>
                      {roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
                    </select>
                  </td>
                  <td className="p-2 text-right tabular-nums">{fmtHours(row.hours)}</td>
                  <td className="p-2 text-muted-foreground">{row.automaticRuleApplied ?? 'Manual'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[0.95fr_1.05fr] gap-4">
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div>
            <h2 className="text-sm font-bold text-foreground">Demanda por capitulo / frente</h2>
            <p className="text-xs text-muted-foreground">Mostra onde a obra mais consome mao de obra pelo Cronograma.</p>
          </div>
          <div className="mt-3 max-h-[330px] overflow-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-muted-foreground">
                <tr>
                  <th className="p-2 text-left">Capitulo / frente</th>
                  <th className="p-2 text-right">Horas</th>
                  <th className="p-2 text-right">Pessoas</th>
                  <th className="p-2 text-left">Cargos principais</th>
                </tr>
              </thead>
              <tbody>
                {projection.phaseSummaries.slice(0, 18).map(row => (
                  <tr key={row.phaseId} className="border-t border-border">
                    <td className="p-2 align-top">
                      <div className="font-semibold text-foreground">{row.phaseName}</div>
                      <div className="text-[10px] text-muted-foreground">{row.taskCount} tarefa(s) com RUP</div>
                    </td>
                    <td className="p-2 align-top text-right tabular-nums">{fmtHours(row.hours)}</td>
                    <td className="p-2 align-top text-right tabular-nums">{row.recommendedPeople}</td>
                    <td className="p-2 align-top text-muted-foreground">{row.mainRoles.join(', ') || '-'}</td>
                  </tr>
                ))}
                {projection.phaseSummaries.length === 0 && (
                  <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">Sem demanda RUP vinculada ao cronograma.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div>
            <h2 className="text-sm font-bold text-foreground">Tarefas que precisam de decisao</h2>
            <p className="text-xs text-muted-foreground">Lista operacional para transformar o calculo em acao de equipe.</p>
          </div>
          <div className="mt-3 max-h-[330px] overflow-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-muted-foreground">
                <tr>
                  <th className="p-2 text-left">Tarefa</th>
                  <th className="p-2 text-left">Equipe</th>
                  <th className="p-2 text-right">Horas</th>
                  <th className="p-2 text-left">Acao</th>
                </tr>
              </thead>
              <tbody>
                {actionableTasks.slice(0, 30).map(row => (
                  <tr key={row.taskId} className="border-t border-border">
                    <td className="p-2 align-top">
                      <div className="font-semibold text-foreground">{row.taskName}</div>
                      <div className="text-[10px] text-muted-foreground">{row.phaseName} | {row.startDate || '-'} a {row.endDate || '-'}</div>
                    </td>
                    <td className="p-2 align-top">{row.teamName ?? 'Sem equipe'}</td>
                    <td className="p-2 align-top text-right tabular-nums">{fmtHours(row.totalHours)}</td>
                    <td className="p-2 align-top">
                      {row.status === 'sem_equipe' ? (
                        <span className="text-warning">Definir equipe com {row.requiredRoles.join(', ')}</span>
                      ) : (
                        <span className="text-warning">Falta: {row.missingRoles.join(', ')}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {actionableTasks.length === 0 && (
                  <tr><td colSpan={4} className="p-6 text-center text-success">Todas as tarefas com RUP tem equipe compativel.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[0.95fr_1.05fr] gap-4">
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-foreground">Disponivel x necessario</h2>
              <p className="text-xs text-muted-foreground">Cadastre a capacidade atual da obra por cargo.</p>
            </div>
            <div className="text-[11px] text-muted-foreground">Jornada padrao: {settings.defaultDailyHours}h/dia</div>
          </div>

          <div className="mt-3 max-h-[560px] overflow-auto pr-1 space-y-2">
            {projection.summaries.map(row => {
              const availabilityRow = availability.find(item => item.operationalRoleId === row.roleId);
              return (
                <div key={row.roleId} className="rounded-lg border border-border bg-background p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-foreground">{row.roleName}</div>
                      <div className="text-[11px] text-muted-foreground">
                        Necessario calc.: {fmtPeople(row.calculatedPeople)} | Recomendado: {row.recommendedPeople}
                      </div>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      row.status === 'deficit' ? 'bg-warning/15 text-warning' :
                      row.status === 'surplus' ? 'bg-success/15 text-success' :
                      'bg-muted text-muted-foreground'
                    }`}>
                      {row.status === 'deficit' ? `${Math.abs(row.balancePeople)} faltando` : row.status === 'surplus' ? `${row.balancePeople} sobra` : 'equilibrado'}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-[1fr_84px_84px] items-center gap-2">
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${pct(row.hours, maxRoleHours)}%` }} />
                    </div>
                    <Input
                      type="number"
                      min={0}
                      value={availabilityRow?.quantity ?? 0}
                      onFocus={e => e.currentTarget.select()}
                      onChange={event => applyAvailability(row.roleId, { quantity: Math.max(0, Number(event.target.value)) })}
                      className="h-8 text-center text-xs"
                      title="Quantidade disponivel"
                    />
                    <Input
                      type="number"
                      min={1}
                      value={availabilityRow?.dailyHours ?? settings.defaultDailyHours}
                      onFocus={e => e.currentTarget.select()}
                      onChange={event => applyAvailability(row.roleId, { dailyHours: Math.max(1, Number(event.target.value)) })}
                      className="h-8 text-center text-xs"
                      title="Jornada diaria"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-foreground">Histograma e curva de mao de obra</h2>
              <p className="text-xs text-muted-foreground">Demanda mensal calculada a partir do Cronograma.</p>
            </div>
            <select
              value={selectedRole}
              onChange={event => setSelectedRole(event.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="todos">Todos os cargos</option>
              {roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
            </select>
          </div>

          <div className="mt-3 max-h-[430px] overflow-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-muted-foreground">
                <tr>
                  <th className="p-2 text-left">Periodo</th>
                  <th className="p-2 text-left">Cargo</th>
                  <th className="p-2 text-right">Horas</th>
                  <th className="p-2 text-right">Nec.</th>
                  <th className="p-2 text-right">Disp.</th>
                  <th className="p-2 text-left">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {filteredPeriods.map(row => (
                  <tr key={`${row.period}-${row.roleId}`} className="border-t border-border">
                    <td className="p-2 font-medium">{row.period}</td>
                    <td className="p-2">{row.roleName}</td>
                    <td className="p-2 text-right tabular-nums">{fmtHours(row.hours)}</td>
                    <td className="p-2 text-right tabular-nums">{row.recommendedPeople}</td>
                    <td className="p-2 text-right tabular-nums">{row.availablePeople}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 rounded-full bg-muted overflow-hidden">
                          <div className={`h-full rounded-full ${row.balancePeople < 0 ? 'bg-warning' : 'bg-success'}`} style={{ width: `${pct(row.recommendedPeople, maxMonthlyPeople)}%` }} />
                        </div>
                        <span className={row.balancePeople < 0 ? 'text-warning font-semibold' : 'text-success'}>
                          {row.balancePeople}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredPeriods.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-muted-foreground">Sem demanda RUP para o filtro selecionado.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold text-foreground">Alertas de equipe</h2>
        </div>
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-2">
          {[...incompatible, ...noTeam].slice(0, 8).map(row => (
            <div key={row.taskId} className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
              <div className="font-semibold text-foreground">{row.taskName}</div>
              <div className="mt-1 text-muted-foreground">Equipe atual: {row.teamName ?? 'sem equipe'}</div>
              <div className="mt-1 text-warning">Falta: {row.missingRoles.join(', ') || 'definir equipe compativel'}</div>
            </div>
          ))}
          {incompatible.length === 0 && noTeam.length === 0 && (
            <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-xs text-success">
              Nenhuma incompatibilidade encontrada nas tarefas com RUP e equipe.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  desc,
  tone = 'default',
}: {
  icon: ElementType;
  label: string;
  value: string | number;
  desc: string;
  tone?: 'default' | 'primary' | 'warning' | 'success' | 'muted';
}) {
  const toneClass = tone === 'warning'
    ? 'border-warning/35 bg-warning/5'
    : tone === 'success'
      ? 'border-success/35 bg-success/5'
      : tone === 'primary'
        ? 'border-primary/35 bg-primary/5'
        : 'border-border bg-card';
  return (
    <div className={`rounded-xl border p-3 shadow-sm ${toneClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</span>
        <Icon className="w-4 h-4 text-primary" />
      </div>
      <div className="mt-2 text-lg font-bold text-foreground tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{desc}</div>
    </div>
  );
}
