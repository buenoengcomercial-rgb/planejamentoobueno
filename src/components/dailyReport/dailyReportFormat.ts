import { AlertOctagon, AlertTriangle, CheckCircle2, Clock4, Cloud, CloudRain, CloudSun, FileText, Sun } from 'lucide-react';
import type { WeatherCondition, WorkCondition } from '@/types/project';

export const PHOTO_BUCKET = 'daily-report-photos';
export const GENERAL_TASK_VALUE = '__general__';

export const WEATHER_OPTIONS: Array<{ value: WeatherCondition; label: string; icon: React.ElementType }> = [
  { value: 'ensolarado', label: 'Ensolarado', icon: Sun },
  { value: 'parcialmente_nublado', label: 'Parc. nublado', icon: CloudSun },
  { value: 'nublado', label: 'Nublado', icon: Cloud },
  { value: 'chuvoso', label: 'Chuvoso', icon: CloudRain },
  { value: 'outro', label: 'Outro', icon: AlertTriangle },
];

export const WORK_OPTIONS: Array<{ value: WorkCondition; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'parcialmente_prejudicada', label: 'Parcialmente prejudicada' },
  { value: 'paralisada', label: 'Paralisada' },
  { value: 'outro', label: 'Outro' },
];

export const WEATHER_LABEL_MAP: Record<string, string> = {
  ensolarado: 'Ensolarado',
  parcialmente_nublado: 'Parc. nublado',
  nublado: 'Nublado',
  chuvoso: 'Chuvoso',
  outro: 'Outro',
};

export const STATUS_META = {
  filled:       { label: 'Preenchido',     row: 'bg-success/5 hover:bg-success/10',           pill: 'text-success border-success/40 bg-success/10',           icon: CheckCircle2 },
  pending:      { label: 'Pendente',       row: 'bg-warning/5 hover:bg-warning/10',           pill: 'text-warning border-warning/40 bg-warning/10',           icon: Clock4 },
  notFilled:    { label: 'Não preenchido', row: 'bg-muted/20 hover:bg-muted/40',               pill: 'text-muted-foreground border-border bg-muted/40',         icon: Clock4 },
  noProduction: { label: 'Sem produção',   row: 'bg-orange-500/5 hover:bg-orange-500/10',     pill: 'text-orange-600 border-orange-500/40 bg-orange-500/10', icon: FileText },
  impediment:   { label: 'Com impedimento',row: 'bg-destructive/5 hover:bg-destructive/10',   pill: 'text-destructive border-destructive/40 bg-destructive/10', icon: AlertOctagon },
} as const;

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatBR(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Lê arquivo como dataURL (usado para preview e fallback). */
export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Nome curto da atividade para títulos de fotos no PDF. */
export function shortTaskName(raw?: string, max = 50): string {
  if (!raw) return '—';
  let s = raw.trim();
  // Corta no primeiro separador estrutural
  const cut = s.search(/[,.;–—()/-]/);
  if (cut > 0) s = s.slice(0, cut).trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s || '—';
}
