import type { Project } from '@/types/project';

/** Apontamento de produção do dia, derivado dos dailyLogs da EAP. */
export interface ProductionEntry {
  chapterId: string;
  chapterName: string;
  chapterNumber: string;
  subChapterId?: string;
  subChapterName?: string;
  subChapterNumber?: string;
  taskId: string;
  /** Código hierárquico da tarefa na planilha contratual (ex.: "1.2.3"). */
  taskCode?: string;
  taskName: string;
  unit: string;
  actualQuantity: number;
  plannedQuantity: number;
  notes?: string;
  /** Equipe vinculada à tarefa (para sugestão automática de equipes presentes). */
  teamCode?: string;
}

export interface DailyReportProps {
  project: Project;
  onProjectChange: (next: Project | ((prev: Project) => Project)) => void;
  undoButton?: React.ReactNode;
  /** Mantém consulta, impressão e navegação disponíveis, sem expor controles de edição. */
  readOnly?: boolean;
  /** Somente o Proprietário pode reabrir um Diário concluído. */
  canManageConclusion?: boolean;
  /** Data ISO inicial vinda da Medição (ao clicar em "Abrir Diário"). */
  initialDate?: string;
  /** Filtro de medição inicial vindo da Medição (ex.: 'draft' ou id da medição). */
  initialMeasurementFilter?: string;
  /** Chave que muda a cada navegação externa, força re-aplicar initialDate/initialMeasurementFilter
   *  mesmo quando os valores se repetem. */
  navKey?: number;
}
