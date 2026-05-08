import type { AdditiveComposition, AdditiveStatus } from '@/types/project';

export interface CompGroup {
  phaseId: string;
  number: string;
  name: string;
  depth: number;
  rows: AdditiveComposition[];
  children: CompGroup[];
  subtotalTotalFonte: number;
  subtotalContratado: number;
  subtotalSuprimido: number;
  subtotalAcrescido: number;
  subtotalFinal: number;
  subtotalDiferenca: number;
}

export const STATUS_LABEL: Record<AdditiveStatus, string> = {
  rascunho: 'Rascunho',
  em_analise: 'Em análise fiscal',
  reprovado: 'Reprovado',
  aprovado: 'Aprovado',
  aditivo_contratado: 'Aditivo Contratado',
};

export const STATUS_BADGE: Record<AdditiveStatus, string> = {
  rascunho: 'bg-slate-100 text-slate-700 border-slate-300',
  em_analise: 'bg-amber-100 text-amber-800 border-amber-300',
  reprovado: 'bg-rose-100 text-rose-800 border-rose-300',
  aprovado: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  aditivo_contratado: 'bg-primary/15 text-primary border-primary/40',
};

export const fmtBRL = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const fmtNum = (v: number) =>
  (v ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 });

/** Formatação de quantidades com 2 casas decimais (pt-BR). */
export const fmtQty2 = (v: number) =>
  (Number.isFinite(v) ? v : 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const fmtPct = (v: number) =>
  `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

export const COL_COUNT = 19;

// Cores por coluna (padrão leve, focado em impacto)
export const G_BG = {
  id: '',                       // Identificação: neutro (herda zebra)
  qty: '',                      // Quantidades base (herda zebra)
  val: '',                      // Valores base (herda zebra)
  impact: '',                   // Diferença/% Var: neutro
  suppressed: 'bg-rose-50',     // Suprimido
  added: 'bg-emerald-50',       // Acrescido
};
export const G_HEAD = {
  id: 'bg-muted/70 text-foreground',
  qty: 'bg-slate-100 text-slate-700',
  val: 'bg-sky-50 text-sky-900',
  impact: 'bg-emerald-50 text-emerald-900',
};
export const BORDER_L = 'border-l border-border/70';
