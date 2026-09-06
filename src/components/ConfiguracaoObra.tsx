import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus, CalendarX2, Info, Settings, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { ESTADOS_BRASIL, getFeriadosAno, getMunicipios, CAPITAIS } from '@/lib/feriados';
import { parseScheduleDate } from '@/lib/scheduleCalendar';
import type { AuditUserInfo } from '@/lib/audit';
import type { Project, ProjectScheduleCalendar, WorkdayException } from '@/types/project';

export type ObraConfig = ProjectScheduleCalendar;

export const DEFAULT_OBRA_CONFIG: ObraConfig = {
  uf: 'SP', municipio: 'São Paulo', jornadaDiaria: 8, trabalhaSabado: false, exceptions: [],
};

const STORAGE_KEY = 'obra-config';

function normalizeConfig(value?: Partial<ObraConfig> | null): ObraConfig {
  return {
    uf: value?.uf || DEFAULT_OBRA_CONFIG.uf,
    municipio: value?.municipio || DEFAULT_OBRA_CONFIG.municipio,
    jornadaDiaria: Number(value?.jornadaDiaria) || DEFAULT_OBRA_CONFIG.jornadaDiaria,
    trabalhaSabado: !!value?.trabalhaSabado,
    exceptions: (value?.exceptions ?? []).filter(item => item?.date && item?.reason),
  };
}

/** Compatibilidade para obras que ainda não gravaram o calendário no projeto. */
export function loadObraConfig(): ObraConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeConfig(JSON.parse(saved));
  } catch {}
  return { ...DEFAULT_OBRA_CONFIG };
}

export function resolveObraConfig(project?: Pick<Project, 'scheduleCalendar'> | null): ObraConfig {
  return project?.scheduleCalendar ? normalizeConfig(project.scheduleCalendar) : loadObraConfig();
}

function saveObraConfig(config: ObraConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function makeExceptionId() {
  return `workday-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function blockedDateInfo(date: string, config: ObraConfig) {
  if (!date) return null;
  const value = parseScheduleDate(date);
  if (Number.isNaN(value.getTime())) return null;
  const holiday = getFeriadosAno(value.getFullYear(), config.uf, config.municipio).find(item => item.data === date);
  const saturday = value.getDay() === 6;
  const sunday = value.getDay() === 0;
  if (!holiday && !saturday) return sunday ? { allowed: false, label: 'Domingo comum não pode ser liberado.' } : { allowed: false, label: 'Selecione um sábado ou feriado.' };
  const parts = [saturday ? 'Sábado' : '', holiday ? `Feriado ${holiday.tipo}: ${holiday.nome}` : ''].filter(Boolean);
  return { allowed: true, label: parts.join(' · ') };
}

interface Props {
  config: ObraConfig;
  onConfigChange: (config: ObraConfig) => void;
  canManage?: boolean;
  auditActor?: AuditUserInfo;
}

export default function ConfiguracaoObra({ config, onConfigChange, canManage = false, auditActor = {} }: Props) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState<ObraConfig>(config);
  const [municipios, setMunicipios] = useState<string[]>([]);
  const [municipioSearch, setMunicipioSearch] = useState('');
  const [exceptionDate, setExceptionDate] = useState('');
  const [exceptionReason, setExceptionReason] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);

  useEffect(() => { setLocal(config); }, [config]);
  useEffect(() => { setMunicipios(getMunicipios(local.uf)); }, [local.uf]);

  const dateInfo = useMemo(() => blockedDateInfo(exceptionDate, local), [exceptionDate, local]);
  const orderedExceptions = useMemo(() => [...(local.exceptions ?? [])].sort((a, b) => a.date.localeCompare(b.date)), [local.exceptions]);
  const removal = orderedExceptions.find(item => item.id === removeId);

  const handleSave = () => {
    saveObraConfig(local);
    onConfigChange(local);
    setOpen(false);
  };

  const handleUfChange = (uf: string) => {
    const capital = CAPITAIS[uf] || '';
    setLocal(prev => ({ ...prev, uf, municipio: capital }));
  };

  const addException = () => {
    const reason = exceptionReason.trim();
    if (!exceptionDate || !dateInfo?.allowed || !reason || local.exceptions?.some(item => item.date === exceptionDate)) return;
    const item: WorkdayException = {
      id: makeExceptionId(), date: exceptionDate, reason,
      createdAt: new Date().toISOString(),
      createdBy: auditActor.userName || auditActor.userEmail,
      createdByEmail: auditActor.userEmail,
    };
    setLocal(prev => ({ ...prev, exceptions: [...(prev.exceptions ?? []), item] }));
    setExceptionDate('');
    setExceptionReason('');
  };

  const filteredMunicipios = municipios.filter(m => m.toLowerCase().includes(municipioSearch.toLowerCase()));
  const canAddException = !!exceptionDate && !!exceptionReason.trim() && !!dateInfo?.allowed && !local.exceptions?.some(item => item.date === exceptionDate);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button disabled={!canManage} className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-md border border-border bg-card text-muted-foreground hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-60" title={canManage ? 'Configurações da obra' : 'Somente Proprietário e Administrador podem alterar o calendário'}>
          <Settings className="w-3 h-3" /> Configurações
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle className="text-base">Configuração da Obra</DialogTitle></DialogHeader>
        <div className="space-y-5 pt-2">
          <div className="grid gap-4 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2">
            <div className="space-y-2"><Label className="text-xs font-medium">Estado</Label><Select value={local.uf} onValueChange={handleUfChange}><SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger><SelectContent>{ESTADOS_BRASIL.map(e => <SelectItem key={e.uf} value={e.uf} className="text-sm">{e.uf} — {e.nome}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2"><Label className="text-xs font-medium">Jornada diária (horas)</Label><Input type="number" value={local.jornadaDiaria} onChange={e => setLocal(prev => ({ ...prev, jornadaDiaria: Number(e.target.value) || 8 }))} min={1} max={12} className="h-9 text-sm" /></div>
            <div className="space-y-2 sm:col-span-2"><Label className="text-xs font-medium">Município</Label><Input value={local.municipio} onChange={e => setLocal(prev => ({ ...prev, municipio: e.target.value }))} placeholder="Digite o nome do município" className="h-9 text-sm" />{filteredMunicipios.length > 0 && local.municipio && <div className="flex flex-wrap gap-1">{filteredMunicipios.slice(0, 5).map(m => <button key={m} type="button" onClick={() => setLocal(prev => ({ ...prev, municipio: m }))} className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${local.municipio === m ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-secondary-foreground border-border hover:bg-accent'}`}>{m}</button>)}</div>}</div>
            <div className="flex items-center gap-3 sm:col-span-2"><Switch checked={local.trabalhaSabado} onCheckedChange={v => setLocal(prev => ({ ...prev, trabalhaSabado: v }))} /><Label className="text-xs font-medium">Trabalha sábado? (meio período — 4h)</Label></div>
          </div>

          <section className="rounded-lg border border-primary/25 bg-primary/[0.03] p-4" aria-labelledby="workday-exceptions-title">
            <div className="flex gap-3"><div className="mt-0.5 rounded-md bg-primary/10 p-2 text-primary"><CalendarPlus className="h-4 w-4" /></div><div><h3 id="workday-exceptions-title" className="text-sm font-semibold">Exceções de expediente</h3><p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Libere pontualmente sábados e feriados como jornada integral. A alteração não reprograma as atividades existentes.</p></div></div>
            <div className="mt-4 grid gap-3 rounded-md border bg-background/80 p-3 sm:grid-cols-[150px_1fr_auto]">
              <div><Label className="mb-1 block text-xs font-medium">Data</Label><Input type="date" value={exceptionDate} onChange={event => setExceptionDate(event.target.value)} className="min-h-11" /></div>
              <div><Label className="mb-1 block text-xs font-medium">Motivo</Label><Input value={exceptionReason} onChange={event => setExceptionReason(event.target.value)} placeholder="Ex.: concretagem emergencial" className="min-h-11" /></div>
              <Button type="button" className="min-h-11 self-end" disabled={!canAddException} onClick={addException}>Liberar dia</Button>
              {exceptionDate && <div className={`flex items-center gap-2 text-xs sm:col-span-3 ${dateInfo?.allowed ? 'text-primary' : 'text-destructive'}`}><Info className="h-3.5 w-3.5" />{dateInfo?.label}{local.exceptions?.some(item => item.date === exceptionDate) && ' · Esta data já está liberada.'}</div>}
            </div>
            <div className="mt-3 space-y-2">{orderedExceptions.length ? orderedExceptions.map(item => <div key={item.id} className="flex items-start gap-3 rounded-md border border-primary/20 bg-background p-3"><CalendarPlus className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><strong className="text-sm">{new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${item.date}T12:00:00Z`))}</strong><span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">Jornada integral</span></div><p className="mt-1 text-xs text-muted-foreground">{item.reason}</p><p className="mt-1 text-[10px] text-muted-foreground">Incluído por {item.createdBy || 'usuário não informado'} em {new Date(item.createdAt).toLocaleString('pt-BR')}</p></div><Button type="button" size="icon" variant="ghost" className="min-h-11 min-w-11 text-destructive" onClick={() => setRemoveId(item.id)} aria-label={`Remover exceção de ${item.date}`}><Trash2 className="h-4 w-4" /></Button></div>) : <div className="rounded-md border border-dashed bg-background/50 p-4 text-center text-xs text-muted-foreground"><CalendarX2 className="mx-auto mb-2 h-4 w-4" />Nenhuma data excepcional liberada.</div>}</div>
          </section>
          <Button onClick={handleSave} className="w-full">Salvar configurações</Button>
        </div>
        <AlertDialog open={!!removeId} onOpenChange={value => !value && setRemoveId(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remover exceção de expediente?</AlertDialogTitle><AlertDialogDescription>A data {removal?.date} voltará a seguir o calendário normal. Nenhuma atividade será reprogramada automaticamente.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (removeId) setLocal(prev => ({ ...prev, exceptions: (prev.exceptions ?? []).filter(item => item.id !== removeId) })); setRemoveId(null); }}>Remover exceção</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
