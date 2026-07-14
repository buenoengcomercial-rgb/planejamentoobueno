// Equipes dinâmicas — persistidas dentro do Project.
// As 8 equipes padrão (Alpha…Hotel) com cores originais permanecem como fallback
// para projetos que ainda não tenham `project.teams` definido.

export type TeamCode = string;

export interface TeamWorker {
  id: string;
  name: string;
  role?: string;
  active?: boolean;
}

export interface TeamDefinition {
  code: TeamCode;
  label: string;
  composition: string;
  /** Operarios vinculados a esta equipe para rastrear producao por colaborador. */
  workers?: TeamWorker[];
  /** Composicao executiva usada pelo dimensionamento. Mantem `composition` como texto legado. */
  members?: Array<{ operationalRoleId: string; quantity: number; dailyHours?: number }>;
  dailyHours?: number;
  active?: boolean;
  calendar?: string;
  /** Cor clara (≈94% L) para o fundo da linha na sidebar/EAP */
  bgColor: string;
  /** Cor escura (≈18-22% L) para texto sobre o fundo claro */
  textColor: string;
  /** Cor média/saturada para borda da barra e marcadores */
  borderColor: string;
  /** Cor média/saturada para a barra do Gantt */
  barColor: string;
}

/** Paleta automática para novas equipes criadas pelo usuário. */
const AUTO_PALETTE: { hue: number; sat: number }[] = [
  { hue: 210, sat: 60 },
  { hue: 152, sat: 50 },
  { hue: 280, sat: 40 },
  { hue: 24,  sat: 60 },
  { hue: 340, sat: 55 },
  { hue: 60,  sat: 50 },
  { hue: 190, sat: 55 },
  { hue: 0,   sat: 55 },
];

/** Deriva o quarteto de cores (bg/bar/border/text) a partir de matiz e saturação. */
export function deriveTeamColors(hue: number, saturation: number): Pick<TeamDefinition, 'bgColor' | 'barColor' | 'borderColor' | 'textColor'> {
  return {
    bgColor:     `hsl(${hue}, ${saturation}%, 94%)`,
    barColor:    `hsl(${hue}, ${saturation}%, 48%)`,
    borderColor: `hsl(${hue}, ${saturation}%, 40%)`,
    textColor:   `hsl(${hue}, ${saturation}%, 18%)`,
  };
}

/** Equipes padrão — códigos e cores preservados conforme o projeto original. */
export const DEFAULT_TEAMS: TeamDefinition[] = [
  { code: 'alpha',   label: 'Alpha',   composition: 'Ajudante',
    members: [{ operationalRoleId: 'ajudante-servente', quantity: 1 }],
    bgColor: 'hsl(270, 50%, 94%)', textColor: 'hsl(270, 50%, 22%)', borderColor: 'hsl(270, 50%, 50%)', barColor: 'hsl(270, 50%, 50%)' },
  { code: 'bravo',   label: 'Bravo',   composition: 'Equipe Engenharia',
    members: [{ operationalRoleId: 'engenheiro', quantity: 1 }],
    bgColor: 'hsl(0, 0%, 95%)',    textColor: 'hsl(0, 0%, 18%)',    borderColor: 'hsl(0, 0%, 55%)',    barColor: 'hsl(0, 0%, 45%)' },
  { code: 'charlie', label: 'Charlie', composition: 'Eletricista + Ajudante',
    members: [{ operationalRoleId: 'eletricista', quantity: 1 }, { operationalRoleId: 'auxiliar-eletricista', quantity: 1 }, { operationalRoleId: 'ajudante-servente', quantity: 1 }],
    bgColor: 'hsl(210, 65%, 94%)', textColor: 'hsl(210, 65%, 20%)', borderColor: 'hsl(210, 65%, 45%)', barColor: 'hsl(210, 65%, 45%)' },
  { code: 'delta',   label: 'Delta',   composition: 'Auxiliar + Ajudante',
    members: [{ operationalRoleId: 'auxiliar-eletricista', quantity: 1 }, { operationalRoleId: 'ajudante-servente', quantity: 1 }],
    bgColor: 'hsl(152, 60%, 94%)', textColor: 'hsl(152, 60%, 18%)', borderColor: 'hsl(152, 60%, 42%)', barColor: 'hsl(152, 60%, 42%)' },
  { code: 'echo',    label: 'Echo',    composition: 'Encanador + Ajudante',
    members: [{ operationalRoleId: 'encanador', quantity: 1 }, { operationalRoleId: 'ajudante-servente', quantity: 1 }],
    bgColor: 'hsl(0, 65%, 94%)',   textColor: 'hsl(0, 65%, 22%)',   borderColor: 'hsl(0, 65%, 45%)',   barColor: 'hsl(0, 65%, 45%)' },
  { code: 'foxtrot', label: 'Foxtrot', composition: 'Encanador + Ajudante',
    members: [{ operationalRoleId: 'encanador', quantity: 1 }, { operationalRoleId: 'ajudante-servente', quantity: 1 }],
    bgColor: 'hsl(30, 80%, 93%)',  textColor: 'hsl(30, 80%, 22%)',  borderColor: 'hsl(30, 80%, 45%)',  barColor: 'hsl(30, 80%, 48%)' },
  { code: 'golf',    label: 'Golf',    composition: 'Equipe de Gesso',
    members: [{ operationalRoleId: 'gesseiro-drywall', quantity: 1 }, { operationalRoleId: 'ajudante-servente', quantity: 1 }],
    bgColor: 'hsl(290, 50%, 94%)', textColor: 'hsl(290, 50%, 22%)', borderColor: 'hsl(290, 50%, 45%)', barColor: 'hsl(290, 50%, 45%)' },
  { code: 'hotel',   label: 'Hotel',   composition: 'Pedreiros',
    members: [{ operationalRoleId: 'pedreiro', quantity: 1 }, { operationalRoleId: 'ajudante-servente', quantity: 1 }],
    bgColor: 'hsl(210, 70%, 94%)', textColor: 'hsl(210, 70%, 20%)', borderColor: 'hsl(210, 70%, 40%)', barColor: 'hsl(210, 70%, 45%)' },
];

/** Mapa indexado por código. Sempre derivado de uma lista. */
export function indexTeams(teams: TeamDefinition[]): Record<TeamCode, TeamDefinition> {
  return Object.fromEntries(teams.map(t => [t.code, t]));
}

/** Cria nova equipe com cor automática conforme posição na lista. */
export function createTeam(label: string, composition: string, existing: TeamDefinition[], workers: TeamWorker[] = []): TeamDefinition {
  const palette = AUTO_PALETTE[existing.length % AUTO_PALETTE.length];
  const slug = label.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'team';
  const code = `${slug}-${Date.now().toString(36)}`;
  return { code, label: label.trim(), composition: composition.trim(), workers, ...deriveTeamColors(palette.hue, palette.sat) };
}

/* ============================================================
 * Camada de compatibilidade — mantém o código existente funcionando.
 * Componentes que ainda importam TEAM_DEFINITIONS/TEAM_CODES/getTeamDefinition
 * sem passar a lista do projeto recebem os defaults.
 * ============================================================ */
export const TEAM_DEFINITIONS: Record<TeamCode, TeamDefinition> = indexTeams(DEFAULT_TEAMS);
export const TEAM_CODES: TeamCode[] = DEFAULT_TEAMS.map(t => t.code);

export function getTeamDefinition(team?: TeamCode, teams?: TeamDefinition[]): TeamDefinition | undefined {
  if (!team) return undefined;
  const list = teams ?? DEFAULT_TEAMS;
  return list.find(t => t.code === team);
}
