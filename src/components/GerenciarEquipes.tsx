import { useState, useMemo } from 'react';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import { TeamDefinition, TeamWorker, createTeam, deriveTeamColors, DEFAULT_TEAMS } from '@/lib/teams';
import { Project } from '@/types/project';
import { toast } from 'sonner';

interface Props {
  project: Project;
  onProjectChange: (p: Project) => void;
}

export default function GerenciarEquipes({ project, onProjectChange }: Props) {
  const teams = useMemo<TeamDefinition[]>(
    () => project.teams ?? DEFAULT_TEAMS,
    [project.teams],
  );

  // Conta tarefas por equipe — usado para bloquear remoção e mostrar uso.
  const usageByCode = useMemo(() => {
    const map = new Map<string, number>();
    project.phases.forEach(ph => ph.tasks.forEach(t => {
      if (t.team) map.set(t.team, (map.get(t.team) ?? 0) + 1);
    }));
    return map;
  }, [project]);

  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editComposition, setEditComposition] = useState('');
  const [editWorkersText, setEditWorkersText] = useState('');
  const [editHue, setEditHue] = useState(210);
  const [editSat, setEditSat] = useState(60);

  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newComposition, setNewComposition] = useState('');
  const [newWorkersText, setNewWorkersText] = useState('');

  const workersToText = (workers?: TeamWorker[]) =>
    (workers ?? []).filter(w => w.active !== false).map(w => w.role ? `${w.name} - ${w.role}` : w.name).join('\n');

  const parseWorkers = (text: string, previous: TeamWorker[] = []): TeamWorker[] => {
    const previousByName = new Map(previous.map(w => [w.name.trim().toLowerCase(), w]));
    return text
      .split(/\r?\n|,/)
      .map(raw => raw.trim())
      .filter(Boolean)
      .map(raw => {
        const [nameRaw, roleRaw] = raw.split(/\s+-\s+/, 2);
        const name = nameRaw.trim();
        const existing = previousByName.get(name.toLowerCase());
        return {
          id: existing?.id ?? `worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          name,
          role: roleRaw?.trim() || existing?.role,
          active: true,
        };
      });
  };

  const persist = (next: TeamDefinition[]) => {
    onProjectChange({ ...project, teams: next });
  };

  const startEdit = (team: TeamDefinition) => {
    setEditingCode(team.code);
    setEditLabel(team.label);
    setEditComposition(team.composition);
    setEditWorkersText(workersToText(team.workers));
    const m = team.bgColor.match(/hsl\(\s*(\d+)\s*,\s*(\d+)/i);
    if (m) { setEditHue(Number(m[1])); setEditSat(Number(m[2])); }
    else   { setEditHue(210); setEditSat(60); }
  };

  const saveEdit = (code: string) => {
    if (!editLabel.trim()) { toast.error('Nome é obrigatório'); return; }
    const next = teams.map(t => t.code === code
      ? { ...t, label: editLabel.trim(), composition: editComposition.trim(), workers: parseWorkers(editWorkersText, t.workers), ...deriveTeamColors(editHue, editSat) }
      : t);
    persist(next);
    setEditingCode(null);
  };

  const removeTeam = (team: TeamDefinition) => {
    const used = usageByCode.get(team.code) ?? 0;
    if (used > 0) {
      toast.error(`Não é possível remover: ${used} tarefa${used > 1 ? 's' : ''} usa${used > 1 ? 'm' : ''} esta equipe.`);
      return;
    }
    persist(teams.filter(t => t.code !== team.code));
  };

  const addTeam = () => {
    if (!newLabel.trim()) { toast.error('Informe o nome da equipe'); return; }
    persist([...teams, createTeam(newLabel, newComposition, teams, parseWorkers(newWorkersText))]);
    setNewLabel(''); setNewComposition(''); setNewWorkersText(''); setAdding(false);
  };

  return (
    <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto pr-1 scrollbar-thin">
      {teams.map(team => {
        const used = usageByCode.get(team.code) ?? 0;
        const isEditing = editingCode === team.code;
        return (
          <div
            key={team.code}
            className="rounded-md border px-2 py-1.5 transition-colors"
            style={{ background: team.bgColor, borderColor: team.borderColor }}
          >
            {isEditing ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-1.5">
                  <input
                    value={editLabel}
                    onChange={e => setEditLabel(e.target.value)}
                    placeholder="Nome"
                    className="text-[11px] font-semibold bg-white/70 border border-white/80 rounded px-1.5 py-0.5 w-24 focus:outline-none focus:ring-1 focus:ring-foreground/30"
                  />
                  <input
                    value={editComposition}
                    onChange={e => setEditComposition(e.target.value)}
                    placeholder="Composição"
                    className="text-[11px] bg-white/70 border border-white/80 rounded px-1.5 py-0.5 flex-1 focus:outline-none focus:ring-1 focus:ring-foreground/30"
                  />
                  <button onClick={() => saveEdit(team.code)} className="p-1 rounded hover:bg-white/60 text-emerald-700" title="Salvar">
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setEditingCode(null)} className="p-1 rounded hover:bg-white/60 text-red-700" title="Cancelar">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-2 text-[10px]" style={{ color: team.textColor }}>
                  <span className="opacity-80">Matiz</span>
                  <input
                    type="range" min={0} max={360} value={editHue}
                    onChange={e => setEditHue(Number(e.target.value))}
                    className="flex-1 h-2 cursor-pointer rounded"
                    style={{ background: 'linear-gradient(to right, hsl(0,70%,55%), hsl(60,70%,55%), hsl(120,70%,45%), hsl(180,70%,45%), hsl(240,70%,55%), hsl(300,70%,55%), hsl(360,70%,55%))' }}
                  />
                  <span className="opacity-80">Sat</span>
                  <input
                    type="range" min={0} max={90} value={editSat}
                    onChange={e => setEditSat(Number(e.target.value))}
                    className="w-16 h-2 cursor-pointer"
                  />
                  <div
                    className="w-5 h-5 rounded border"
                    style={{
                      background: `hsl(${editHue}, ${editSat}%, 48%)`,
                      borderColor: `hsl(${editHue}, ${editSat}%, 38%)`,
                    }}
                    title="Pré-visualização"
                  />
                </div>
                <textarea
                  value={editWorkersText}
                  onChange={e => setEditWorkersText(e.target.value)}
                  placeholder="Operarios: um por linha. Ex: Joao Silva - Pedreiro"
                  className="min-h-[54px] text-[11px] bg-white/70 border border-white/80 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-foreground/30"
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-sm flex-shrink-0"
                  style={{ background: team.barColor, border: `1px solid ${team.borderColor}` }}
                />
                <span className="text-[11px] font-semibold flex-shrink-0" style={{ color: team.textColor }}>
                  {team.label}
                </span>
                <span className="text-[10px] truncate flex-1" style={{ color: team.textColor, opacity: 0.85 }}>
                  {team.composition || '—'}
                </span>
                <span
                  className="text-[9px] tabular-nums px-1.5 py-0.5 rounded bg-white/40"
                  style={{ color: team.textColor }}
                  title={`${used} tarefa(s) usando esta equipe`}
                >
                  {used}
                </span>
                <button
                  onClick={() => startEdit(team)}
                  className="p-1 rounded opacity-70 hover:opacity-100 hover:bg-white/40 transition"
                  style={{ color: team.textColor }}
                  title="Editar equipe"
                >
                  <Pencil className="w-3 h-3" />
                </button>
                <button
                  onClick={() => removeTeam(team)}
                  className={`p-1 rounded transition ${used > 0 ? 'opacity-30 cursor-not-allowed' : 'opacity-70 hover:opacity-100 hover:bg-white/40'}`}
                  style={{ color: team.textColor }}
                  title={used > 0 ? `Em uso por ${used} tarefa(s)` : 'Remover equipe'}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        );
      })}

      {adding ? (
        <div className="flex items-center gap-1.5 rounded-md border border-dashed border-border bg-card px-2 py-1.5">
          <input
            autoFocus
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addTeam(); if (e.key === 'Escape') { setAdding(false); setNewLabel(''); setNewComposition(''); setNewWorkersText(''); } }}
            placeholder="Nome da equipe"
            className="text-[11px] bg-background border border-border rounded px-2 py-1 w-28 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            value={newComposition}
            onChange={e => setNewComposition(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addTeam(); }}
            placeholder="Composição (ex: Pedreiro + Servente)"
            className="text-[11px] bg-background border border-border rounded px-2 py-1 flex-1 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            value={newWorkersText}
            onChange={e => setNewWorkersText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addTeam(); }}
            placeholder="Operarios: Joao - Pedreiro, Maria - Servente"
            className="text-[11px] bg-background border border-border rounded px-2 py-1 flex-1 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={addTeam}
            className="px-2 py-1 rounded bg-primary text-primary-foreground text-[10px] font-medium hover:brightness-110"
          >
            Adicionar
          </button>
          <button
            onClick={() => { setAdding(false); setNewLabel(''); setNewComposition(''); setNewWorkersText(''); }}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-dashed border-border text-[11px] font-medium text-muted-foreground hover:text-primary hover:border-primary transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Nova equipe
        </button>
      )}
    </div>
  );
}
