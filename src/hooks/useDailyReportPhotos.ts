import { useCallback, useMemo, useRef, useState } from 'react';
import type { DailyReport, DailyReportAttachment, Project } from '@/types/project';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import {
  GENERAL_TASK_VALUE,
  PHOTO_BUCKET,
  readFileAsDataURL,
  uid,
} from '@/components/dailyReport/dailyReportFormat';
import type { ProductionEntry } from '@/components/dailyReport/types';

interface UseDailyReportPhotosArgs {
  project: Project;
  currentReport: DailyReport;
  persist: (updater: (r: DailyReport) => DailyReport) => void;
  production: ProductionEntry[];
  selectedDate: string;
}

export function useDailyReportPhotos({
  project,
  currentReport,
  persist,
  production,
  selectedDate,
}: UseDailyReportPhotosArgs) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string>(GENERAL_TASK_VALUE);
  const [photoFilter, setPhotoFilter] = useState<string>('all');
  const [uploadingCount, setUploadingCount] = useState(0);
  const [lightbox, setLightbox] = useState<DailyReportAttachment | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DailyReportAttachment | null>(null);

  const photos: DailyReportAttachment[] = useMemo(
    () => (currentReport.attachments || []).filter(a => (a.type ?? 'image') === 'image'),
    [currentReport.attachments],
  );

  const photosByTask = useMemo(() => {
    const m = new Map<string, number>();
    photos.forEach(p => {
      const key = p.taskId || GENERAL_TASK_VALUE;
      m.set(key, (m.get(key) || 0) + 1);
    });
    return m;
  }, [photos]);

  const visiblePhotos = useMemo(() => {
    if (photoFilter === 'all') return photos;
    return photos.filter(p => (p.taskId || GENERAL_TASK_VALUE) === photoFilter);
  }, [photos, photoFilter]);

  const photoTaskOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { value: string; label: string; phaseChain: string; quantity: number; unit: string; taskName: string }[] = [];
    production.forEach(p => {
      if (seen.has(p.taskId)) return;
      seen.add(p.taskId);
      const chain = p.subChapterName
        ? `${p.chapterNumber} ${p.chapterName} > ${p.subChapterNumber} ${p.subChapterName}`
        : `${p.chapterNumber} ${p.chapterName}`;
      const numero = p.subChapterNumber ? `${p.subChapterNumber}` : `${p.chapterNumber}`;
      opts.push({
        value: p.taskId,
        label: `${numero} — ${p.taskName} — ${p.actualQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ${p.unit}`,
        phaseChain: chain,
        quantity: p.actualQuantity,
        unit: p.unit,
        taskName: p.taskName,
      });
    });
    return opts;
  }, [production]);

  const uploadOne = useCallback(async (file: File): Promise<DailyReportAttachment> => {
    const id = uid('att');
    const safeExt = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${project.id || 'local'}/${selectedDate}/${id}.${safeExt}`;
    const taskMeta = pendingTaskId !== GENERAL_TASK_VALUE
      ? photoTaskOptions.find(o => o.value === pendingTaskId)
      : undefined;
    const base: DailyReportAttachment = {
      id,
      type: 'image',
      fileName: file.name,
      mimeType: file.type || 'image/jpeg',
      caption: '',
      taskId: taskMeta?.value,
      taskName: taskMeta?.taskName,
      phaseChain: taskMeta?.phaseChain,
      quantity: taskMeta?.quantity,
      unit: taskMeta?.unit,
      uploadedBy: currentReport.responsible || undefined,
      uploadedAt: new Date().toISOString(),
    };
    try {
      const { error } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
      if (error) throw error;
      // Bucket é privado: a URL é gerada sob demanda via signed URL (resolvePhotoUrl).
      return { ...base, storagePath: path };
    } catch {
      const dataUrl = await readFileAsDataURL(file);
      return { ...base, dataUrl };
    }
  }, [project.id, selectedDate, pendingTaskId, photoTaskOptions, currentReport.responsible]);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
    if (arr.length === 0) return;
    setUploadingCount(c => c + arr.length);
    try {
      const uploaded: DailyReportAttachment[] = [];
      for (const f of arr) {
        try {
          const att = await uploadOne(f);
          uploaded.push(att);
        } catch (err) {
          console.error('Falha ao anexar foto', err);
        }
      }
      if (uploaded.length > 0) {
        persist(r => ({ ...r, attachments: [...(r.attachments || []), ...uploaded] }));
        toast({ title: `${uploaded.length} foto(s) anexada(s)`, description: 'A galeria do dia foi atualizada.' });
      }
    } finally {
      setUploadingCount(c => Math.max(0, c - arr.length));
    }
  }, [uploadOne, persist]);

  const updatePhoto = useCallback((id: string, patch: Partial<DailyReportAttachment>) => persist(r => ({
    ...r,
    attachments: (r.attachments || []).map(a => a.id === id ? { ...a, ...patch } : a),
  })), [persist]);

  const removePhoto = useCallback(async (att: DailyReportAttachment) => {
    if (att.storagePath) {
      try { await supabase.storage.from(PHOTO_BUCKET).remove([att.storagePath]); } catch { /* ignore */ }
    }
    persist(r => ({ ...r, attachments: (r.attachments || []).filter(a => a.id !== att.id) }));
    toast({ title: 'Foto removida' });
  }, [persist]);

  return {
    pendingTaskId,
    setPendingTaskId,
    photoFilter,
    setPhotoFilter,
    uploadingCount,
    lightbox,
    setLightbox,
    confirmDelete,
    setConfirmDelete,
    fileInputRef,
    photos,
    photosByTask,
    visiblePhotos,
    photoTaskOptions,
    handleFiles,
    updatePhoto,
    removePhoto,
  };
}
