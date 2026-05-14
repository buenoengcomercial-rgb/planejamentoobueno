import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PHOTO_BUCKET } from '@/components/dailyReport/dailyReportFormat';
import type { DailyReportAttachment } from '@/types/project';

const TTL_SEC = 3600; // 1h
const cache = new Map<string, { url: string; exp: number }>();

/** Extrai o path no bucket a partir de uma URL legada (publicUrl ou signed). */
function pathFromAtt(att: DailyReportAttachment): string | null {
  if (att.storagePath) return att.storagePath;
  if (att.publicUrl) {
    const m = att.publicUrl.match(/\/storage\/v1\/object\/(?:public|sign)\/daily-report-photos\/([^?]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

/**
 * Resolve a melhor URL disponível para uma foto:
 * - dataUrl embutido (fallback offline) → retorna direto
 * - storagePath ou URL legada → gera/renova signed URL com cache de 1h
 */
export async function resolvePhotoUrl(att: DailyReportAttachment): Promise<string | null> {
  if (att.dataUrl) return att.dataUrl;
  const path = pathFromAtt(att);
  if (!path) return null;
  const nowSec = Date.now() / 1000;
  const hit = cache.get(path);
  if (hit && hit.exp - 60 > nowSec) return hit.url;
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, TTL_SEC);
  if (error || !data?.signedUrl) return null;
  cache.set(path, { url: data.signedUrl, exp: nowSec + TTL_SEC });
  return data.signedUrl;
}

/** Hook React: devolve a URL utilizável da foto, renovando ao trocar o anexo. */
export function usePhotoSrc(att: DailyReportAttachment | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(att?.dataUrl ?? null);
  useEffect(() => {
    let cancelled = false;
    if (!att) { setUrl(null); return; }
    if (att.dataUrl) { setUrl(att.dataUrl); return; }
    resolvePhotoUrl(att).then(u => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [att?.id, att?.storagePath, att?.publicUrl, att?.dataUrl]);
  return url;
}
