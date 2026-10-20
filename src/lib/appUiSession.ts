import type { AppView } from '@/types/project';

const UI_SESSION_VERSION = 1;
const APP_UI_SESSION_KEY = 'obraplanner:ui-session';

export const APP_VIEWS: AppView[] = ['dashboard', 'management', 'gantt', 'tasks', 'measurement', 'dailyReport', 'additive', 'additiveSchedule', 'realCost', 'materials', 'warehouse'];

export const VIEW_ROUTE: Record<AppView, string> = {
  dashboard: 'dashboard',
  management: 'rotina',
  gantt: 'cronograma',
  tasks: 'producao',
  dailyReport: 'diario',
  measurement: 'medicao',
  additive: 'aditivo',
  additiveSchedule: 'cronograma-aditivo',
  realCost: 'custos',
  materials: 'materiais',
  warehouse: 'almoxarifado',
};

export const ROUTE_VIEW: Record<string, AppView> = {
  ...Object.fromEntries(Object.entries(VIEW_ROUTE).map(([view, route]) => [route, view])),
  levantamento: 'tasks',
};

export interface AppUiSession {
  version: typeof UI_SESSION_VERSION;
  projectId?: string;
  view?: AppView;
  mainScrollTop?: number;
  mainScrollLeft?: number;
  windowScrollX?: number;
  windowScrollY?: number;
  updatedAt: string;
}

function isAppView(value: unknown): value is AppView {
  return typeof value === 'string' && APP_VIEWS.includes(value as AppView);
}

export function readAppUiSession(): AppUiSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(APP_UI_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Omit<AppUiSession, 'view'> & { view?: unknown };
    if (parsed.version !== UI_SESSION_VERSION) return null;
    if (parsed.view === 'planTakeoff') return { ...parsed, view: 'tasks' };
    if (parsed.view && !isAppView(parsed.view)) return null;
    return { ...parsed, view: isAppView(parsed.view) ? parsed.view : undefined };
  } catch {
    return null;
  }
}

export function writeAppUiSession(patch: Partial<AppUiSession>) {
  if (typeof window === 'undefined') return;
  try {
    const previous = readAppUiSession();
    localStorage.setItem(APP_UI_SESSION_KEY, JSON.stringify({
      version: UI_SESSION_VERSION,
      ...previous,
      ...patch,
      updatedAt: new Date().toISOString(),
    } satisfies AppUiSession));
  } catch {
    // Sessão visual é apenas conforto operacional; falha aqui não trava a obra.
  }
}

export function readInitialView(routeView?: string): AppView {
  return (routeView && ROUTE_VIEW[routeView]) || readAppUiSession()?.view || 'dashboard';
}
