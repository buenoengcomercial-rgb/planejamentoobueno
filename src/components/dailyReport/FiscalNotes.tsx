import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import type { Json } from '@/integrations/supabase/types';

const BUCKET = 'daily-report-fiscal-photos';
type Photo = { path: string; caption: string };
type Note = { id: string; author_id: string; note: string; photos: Photo[]; updated_at: string };

function parsePhotos(value: Json): Photo[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Photo => !!item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.path === 'string' && typeof item.caption === 'string');
}

export function FiscalNotes({ projectId, date, canWrite }: { projectId: string; date: string; canWrite: boolean }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [myId, setMyId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [caption, setCaption] = useState('');
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setNotes([]); setDraft(''); setUrls({}); setError('');
    void (async () => {
      const [{ data: auth }, { data, error: loadError }] = await Promise.all([
        supabase.auth.getUser(),
        supabase.from('daily_report_fiscal_notes').select('id,author_id,note,photos,updated_at')
          .eq('project_id', projectId).eq('report_date', date).order('created_at'),
      ]);
      if (!active) return;
      if (loadError) { setError(`Não foi possível carregar apontamentos: ${loadError.message}`); return; }
      const userId = auth.user?.id;
      setMyId(userId);
      const rows = (data ?? []).map(row => ({ ...row, photos: parsePhotos(row.photos) }));
      setNotes(rows);
      setDraft(rows.find(row => row.author_id === userId)?.note ?? '');
      for (const photo of rows.flatMap(row => row.photos)) {
        const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(photo.path, 3600);
        if (active && signed?.signedUrl) setUrls(current => ({ ...current, [photo.path]: signed.signedUrl }));
      }
    })();
    return () => { active = false; };
  }, [projectId, date]);

  const save = async (newPhotos?: Photo[]): Promise<boolean> => {
    if (!myId) return false;
    if (!newPhotos) setBusy(true);
    setError('');
    try {
      const current = notes.find(row => row.author_id === myId);
      const photos = newPhotos ?? current?.photos ?? [];
      const { data, error: saveError } = await supabase.from('daily_report_fiscal_notes')
        .upsert({ project_id: projectId, report_date: date, author_id: myId, note: draft, photos: photos as unknown as Json },
          { onConflict: 'project_id,report_date,author_id' })
        .select('id,author_id,note,photos,updated_at').single();
      if (saveError) throw saveError;
      const updated = { ...data, photos: parsePhotos(data.photos) };
      setNotes(rows => [...rows.filter(row => row.author_id !== myId), updated]);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o apontamento.'); return false; }
    finally { if (!newPhotos) setBusy(false); }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length || !myId) return;
    setBusy(true); setError('');
    const added: Photo[] = [];
    try {
      for (const file of Array.from(files)) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Selecione imagens JPG, PNG ou WebP.');
        const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
        const path = `${projectId}/${myId}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type });
        if (uploadError) throw uploadError;
        added.push({ path, caption: caption.trim() });
      }
      const saved = await save([...(notes.find(row => row.author_id === myId)?.photos ?? []), ...added]);
      if (!saved) {
        await supabase.storage.from(BUCKET).remove(added.map(photo => photo.path));
        return;
      }
      for (const photo of added) {
        const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(photo.path, 3600);
        if (signed?.signedUrl) setUrls(current => ({ ...current, [photo.path]: signed.signedUrl }));
      }
      setCaption('');
    } catch (cause) {
      if (added.length) await supabase.storage.from(BUCKET).remove(added.map(photo => photo.path));
      setError(cause instanceof Error ? cause.message : 'Falha no envio da foto.');
    }
    finally { setBusy(false); }
  };

  return <Card>
    <CardHeader><CardTitle className="text-base">Fiscalização</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {notes.length === 0 && <p className="text-sm text-muted-foreground">Nenhum apontamento da fiscalização nesta data.</p>}
      {notes.map(row => <div key={row.id} className="rounded-lg border p-3">
        <p className="text-xs text-muted-foreground">Apontamento da fiscalização · {new Date(row.updated_at).toLocaleString('pt-BR')}</p>
        {row.note && <p className="mt-2 whitespace-pre-wrap text-sm">{row.note}</p>}
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {row.photos.map(photo => <figure key={photo.path}>
            {urls[photo.path] ? <img src={urls[photo.path]} alt={photo.caption || 'Foto da fiscalização'} className="aspect-square w-full rounded object-cover" /> : <div className="aspect-square rounded bg-muted" />}
            {photo.caption && <figcaption className="text-xs">{photo.caption}</figcaption>}
          </figure>)}
        </div>
      </div>)}
      {canWrite && <div className="space-y-2 border-t pt-4">
        <label htmlFor="fiscal-note" className="text-sm font-medium">Seu apontamento</label>
        <Textarea id="fiscal-note" value={draft} onChange={event => setDraft(event.target.value)} placeholder="Registre o apontamento da fiscalização..." />
        <Button type="button" disabled={busy || !myId} onClick={() => void save()}>Salvar apontamento</Button>
        <label htmlFor="fiscal-caption" className="block text-sm font-medium">Legenda das próximas fotos</label>
        <input id="fiscal-caption" className="h-10 w-full rounded border bg-background px-3 text-sm" value={caption} onChange={event => setCaption(event.target.value)} />
        <label className="block text-sm font-medium">Adicionar fotos da fiscalização
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || !myId} onChange={event => { void upload(event.target.files); event.target.value = ''; }} className="mt-1 block w-full text-sm" />
        </label>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </CardContent>
  </Card>;
}
