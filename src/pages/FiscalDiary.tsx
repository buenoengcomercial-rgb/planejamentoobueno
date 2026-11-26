import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { FiscalNotes } from '@/components/dailyReport/FiscalNotes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatBR, WEATHER_LABEL_MAP, WORK_OPTIONS, todayISO } from '@/components/dailyReport/dailyReportFormat';
import { usePhotoSrc } from '@/lib/photoUrl';
import type { DailyReport, DailyReportAttachment } from '@/types/project';

type ProjectSummary = { id: string; name: string; updated_at: string };
type Production = { taskId: string; taskName: string; actualQuantity: number | null; notes: string | null };
type Payload = { report: DailyReport | null; production: Production[] };

function WorkPhoto({ photo }: { photo: DailyReportAttachment }) {
  const src = usePhotoSrc(photo);
  return <figure className="overflow-hidden rounded-lg border">
    {src ? <img src={src} alt={photo.caption || 'Foto da obra'} loading="lazy" className="aspect-[4/3] w-full object-cover" />
      : <div className="flex aspect-[4/3] items-center justify-center bg-muted text-sm text-muted-foreground">Foto indisponível</div>}
    <figcaption className="p-2 text-sm">{photo.caption || photo.taskName || 'Sem legenda'}</figcaption>
  </figure>;
}

export default function FiscalDiary() {
  const { user, signOut } = useAuth();
  const { membership } = useOrganization();
  const { routeProjectId } = useParams();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [date, setDate] = useState(todayISO);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const projectId = projects.find(project => project.id === routeProjectId)?.id ?? projects[0]?.id;

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error: listError } = await supabase.rpc('fiscal_diary_projects');
      if (!active) return;
      setLoading(false);
      if (listError) setError(listError.message);
      else setProjects(data ?? []);
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setLoading(true); setError(''); setPayload(null);
    void (async () => {
      const { data, error: reportError } = await supabase.rpc('fiscal_diary_report', { p_project_id: projectId, p_date: date });
      if (!active) return;
      setLoading(false);
      if (reportError) setError(reportError.message);
      else setPayload(data as unknown as Payload);
    })();
    return () => { active = false; };
  }, [projectId, date]);

  if (!user) return <Navigate to="/auth" replace />;
  if (membership?.role !== 'fiscal') return <Navigate to="/" replace />;
  const report = payload?.report;
  const photos = Array.isArray(report?.attachments) ? report.attachments : [];
  const teams = Array.isArray(report?.teamsPresent) ? report.teamsPresent : [];
  const equipment = Array.isArray(report?.equipment) ? report.equipment : [];
  const workLabel = WORK_OPTIONS.find(option => option.value === report?.workCondition)?.label;

  return <div className="min-h-dvh bg-muted/20">
    <header className="border-b bg-background px-4 py-3">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <div><p className="text-xs text-muted-foreground">ObraPlanner</p><h1 className="text-lg font-semibold">Diário de Obra · Fiscalização</h1></div>
        <Button variant="outline" onClick={() => void signOut()}>Sair</Button>
      </div>
    </header>
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="space-y-1 text-sm font-medium">Obra
          <select aria-label="Obra" className="block h-10 w-full rounded border bg-background px-3" value={projectId ?? ''}
            onChange={event => navigate(`/obras/${event.target.value}/diario`)}>
            {projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm font-medium">Data do Diário
          <input aria-label="Data do Diário" className="block h-10 rounded border bg-background px-3" type="date" value={date}
            onChange={event => setDate(event.target.value)} />
        </label>
      </div>
      {loading && <p role="status">Carregando Diário...</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!loading && !error && !projectId && <p>Nenhuma obra disponível para fiscalização.</p>}
      {projectId && !loading && !error && <>
        <p className="text-sm text-muted-foreground">Diário de {formatBR(date)} · {report ? 'Registro da equipe' : 'Ainda não preenchido pela equipe'}</p>
        <Card><CardHeader><CardTitle className="text-base">Informações do dia</CardTitle></CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
            <p><strong>Responsável:</strong> {report?.responsible || 'Não informado'}</p>
            <p><strong>Clima:</strong> {report?.weatherOther || (report?.weather && WEATHER_LABEL_MAP[report.weather]) || 'Não informado'}</p>
            <p><strong>Condição de trabalho:</strong> {report?.workConditionOther || workLabel || 'Não informado'}</p>
            {report?.noProductionDeclared && <p>Dia declarado sem produção.</p>}
          </CardContent>
        </Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card><CardHeader><CardTitle className="text-base">Equipe presente</CardTitle></CardHeader><CardContent className="space-y-1 text-sm">
            {teams.length ? teams.map(row => <p key={row.id}>{row.name || row.teamCode} · {row.count ?? 0} pessoa(s)</p>) : 'Nenhuma equipe lançada.'}
          </CardContent></Card>
          <Card><CardHeader><CardTitle className="text-base">Equipamentos</CardTitle></CardHeader><CardContent className="space-y-1 text-sm">
            {equipment.length ? equipment.map(row => <p key={row.id}>{row.name} · {row.count ?? 0}</p>) : 'Nenhum equipamento lançado.'}
          </CardContent></Card>
        </div>
        {(payload?.production?.length ?? 0) > 0 && <Card><CardHeader><CardTitle className="text-base">Produção do dia</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          {payload?.production.map((item, index) => <p key={`${item.taskId}-${index}`}>{item.taskName}: {item.actualQuantity ?? 0} realizado(s){item.notes ? ` · ${item.notes}` : ''}</p>)}
        </CardContent></Card>}
        <div className="grid gap-4 md:grid-cols-3">
          {([['Ocorrências', report?.occurrences], ['Impedimentos', report?.impediments], ['Observações gerais', report?.observations]] as const)
            .map(([title, value]) => <Card key={title}><CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
              <CardContent className="min-h-16 whitespace-pre-wrap text-sm">{value || 'Nenhum registro.'}</CardContent></Card>)}
        </div>
        <FiscalNotes projectId={projectId} date={date} canWrite />
        <Card><CardHeader><CardTitle className="text-base">Fotos da Obra ({photos.length})</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{photos.map(photo => <WorkPhoto key={photo.id} photo={photo} />)}</CardContent>
        </Card>
      </>}
    </main>
  </div>;
}
