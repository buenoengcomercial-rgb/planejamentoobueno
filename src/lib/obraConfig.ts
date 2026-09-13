import type { Project, ProjectScheduleCalendar } from '@/types/project';

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
  } catch {
    // Configuração local legada inválida: usa o padrão seguro abaixo.
  }
  return { ...DEFAULT_OBRA_CONFIG };
}

export function resolveObraConfig(project?: Pick<Project, 'scheduleCalendar'> | null): ObraConfig {
  return project?.scheduleCalendar ? normalizeConfig(project.scheduleCalendar) : loadObraConfig();
}

export function saveObraConfig(config: ObraConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
