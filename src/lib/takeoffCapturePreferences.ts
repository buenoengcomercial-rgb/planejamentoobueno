import { CAPTURE_KINDS, type CaptureKind } from './dxfSnap';

export interface CapturePreferences { enabled: boolean; tracking: boolean; kinds: CaptureKind[] }
const empty = (): CapturePreferences => ({ enabled: false, tracking: false, kinds: [] });
const key = (scope: string) => `obraplanner:takeoff-captures:${scope}`;

/** Browser preferences are separate from files, quantities and the cloud workspace. */
export function readCapturePreferences(scope: string): CapturePreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(scope)) ?? 'null');
    if (!value || typeof value !== 'object') return empty();
    const data = value as Partial<CapturePreferences>;
    if (typeof data.enabled !== 'boolean' || typeof data.tracking !== 'boolean' || !Array.isArray(data.kinds)) return empty();
    return { enabled: data.enabled, tracking: data.tracking, kinds: CAPTURE_KINDS.filter(kind => data.kinds!.includes(kind)) };
  } catch { return empty(); }
}

export function saveCapturePreferences(scope: string, value: CapturePreferences): boolean {
  try { localStorage.setItem(key(scope), JSON.stringify(value)); return true; }
  catch { return false; }
}
