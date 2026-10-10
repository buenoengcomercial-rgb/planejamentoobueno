import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readCapturePreferences, saveCapturePreferences } from './takeoffCapturePreferences';
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
describe('armazenamento das opções do ímã', () => {
  it('rejeita conteúdo inválido e ignora tipos desconhecidos/duplicados', () => {
    localStorage.setItem('obraplanner:takeoff-captures:a', 'invalid');
    expect(readCapturePreferences('a')).toEqual({ enabled: false, tracking: false, kinds: [] });
    localStorage.setItem('obraplanner:takeoff-captures:a', JSON.stringify({ enabled: true, tracking: true, kinds: ['endpoint', 'unknown', 'endpoint'] }));
    expect(readCapturePreferences('a')).toEqual({ enabled: true, tracking: true, kinds: ['endpoint'] });
  });
  it('falha de armazenamento não interfere com arquivos ou quantitativos', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
    expect(saveCapturePreferences('a', { enabled: true, tracking: true, kinds: ['nearest'] })).toBe(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    expect(readCapturePreferences('a')).toEqual({ enabled: false, tracking: false, kinds: [] });
  });
});
