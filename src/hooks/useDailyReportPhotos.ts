import { useCallback, useMemo, useRef, useState } from 'react';
import type { DailyReport, DailyReportAttachment, Project } from '@/types/project';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import {
  GENERAL_TASK_VALUE,
  PHOTO_BUCKET,
  uid,
} from '@/components/dailyReport/dailyReportFormat';
import type { ProductionEntry } from '@/components/dailyReport/types';
import { optimizeDailyReportPhoto } from '@/lib/dailyReportPhotoOptimization';
import { ATTACHMENT_OPTIMIZATION_VERSION } from '@/lib/attachmentOptimizationVersion';
import { formatProjectPlaceLabel, requestCameraPhotoStamp, type DailyReportPhotoStamp } from '@/lib/dailyReportPhotoStamp';

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
  const [cameraCaptureState, setCameraCaptureState] = useState<'idle' | 'locating' | 'ready'>('idle');
  const [cameraLocationError, setCameraLocationError] = useState<string | undefined>();
  const preparedCameraLocationRef = useRef<DailyReportPhotoStamp['location']>();

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

  const uploadOne = useCallback(async (file: File, stamp?: DailyReportPhotoStamp): Promise<{ attachment: DailyReportAttachment; originalBytes: number; storedBytes: number }> => {
    const optimized = await optimizeDailyReportPhoto(file, stamp);
    const id = uid('att');
    const safeExt = 'jpg';
    const path = `${project.id || 'local'}/${selectedDate}/${id}.${safeExt}`;
    const taskMeta = pendingTaskId !== GENERAL_TASK_VALUE
      ? photoTaskOptions.find(o => o.value === pendingTaskId)
      : undefined;
    const base: DailyReportAttachment = {
      id,
      type: 'image',
      fileName: optimized.name,
      mimeType: optimized.type,
      caption: '',
      taskId: taskMeta?.value,
      taskName: taskMeta?.taskName,
      phaseChain: taskMeta?.phaseChain,
      quantity: taskMeta?.quantity,
      unit: taskMeta?.unit,
      uploadedBy: currentReport.responsible || undefined,
      uploadedAt: new Date().toISOString(),
      capturedAt: stamp?.capturedAt,
      captureSource: stamp ? 'camera' : undefined,
      latitude: stamp?.location?.latitude,
      longitude: stamp?.location?.longitude,
      locationAccuracy: stamp?.location?.accuracy,
      capturePlaceLabel: stamp?.placeLabel,
      originalBytes: file.size,
      storedBytes: optimized.size,
      optimizedAt: new Date().toISOString(),
      optimizationVersion: ATTACHMENT_OPTIMIZATION_VERSION,

    };
    const { error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(path, optimized, { contentType: optimized.type, upsert: false });
    if (error) throw new Error(`Não foi possível enviar ${file.name}: ${error.message}`);
    // Bucket é privado: a URL é gerada sob demanda via signed URL (resolvePhotoUrl).
    return { attachment: { ...base, storagePath: path }, originalBytes: file.size, storedBytes: optimized.size };
  }, [project.id, selectedDate, pendingTaskId, photoTaskOptions, currentReport.responsible]);

  const uploadFiles = useCallback(async (files: FileList | File[], stamp?: DailyReportPhotoStamp) => {
    const arr = Array.from(files).filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
    if (arr.length === 0) return;
    setUploadingCount(c => c + arr.length);
    try {
      const uploaded: DailyReportAttachment[] = [];
      let originalBytes = 0;
      let storedBytes = 0;
      for (const f of arr) {
        try {
          const result = await uploadOne(f, stamp);
          uploaded.push(result.attachment);
          originalBytes += result.originalBytes;
          storedBytes += result.storedBytes;
        } catch (err) {
          console.error('Falha ao anexar foto', err);
          toast({
            variant: 'destructive',
            title: 'Falha no envio da foto',
            description: err instanceof Error ? err.message : 'Verifique a conexão e tente novamente.',
          });
        }
      }
      if (uploaded.length > 0) {
        persist(r => ({ ...r, attachments: [...(r.attachments || []), ...uploaded] }));
        const savedBytes = Math.max(0, originalBytes - storedBytes);
        const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB`;
        toast({
          title: `${uploaded.length} foto(s) otimizada(s) e anexada(s) — até 100 KB cada`,
          description: savedBytes > 0 ? `Armazenamento reduzido de ${mb(originalBytes)} para ${mb(storedBytes)}.` : `Versão otimizada enviada (${mb(storedBytes)}).`,
        });
      }
    } finally {
      setUploadingCount(c => Math.max(0, c - arr.length));
    }
  }, [uploadOne, persist]);

  const handleFiles = useCallback((files: FileList | File[]) => uploadFiles(files), [uploadFiles]);

  const cameraPlaceLabel = useMemo(() => {
    const calendar = project.scheduleCalendar;
    return formatProjectPlaceLabel(project.contractInfo?.location, calendar?.municipio, calendar?.uf);
  }, [project.contractInfo?.location, project.scheduleCalendar]);

  const prepareCameraCapture = useCallback(async () => {
    if (cameraCaptureState === 'locating') return;
    setCameraCaptureState('locating');
    setCameraLocationError(undefined);
    preparedCameraLocationRef.current = undefined;
    try {
      const stamp = await requestCameraPhotoStamp(cameraPlaceLabel);
      if (!stamp.location) throw new Error('Não foi possível obter a localização do aparelho.');
      preparedCameraLocationRef.current = stamp.location;
      setCameraCaptureState('ready');
      toast({ title: 'Localização obtida', description: 'Toque em Abrir câmera para registrar a foto com o carimbo GPS.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível obter a localização do aparelho.';
      setCameraLocationError(message);
      setCameraCaptureState('idle');
      toast({ variant: 'destructive', title: 'Foto não iniciada', description: message });
    }
  }, [cameraCaptureState, cameraPlaceLabel]);

  const handleCameraFiles = useCallback(async (files: FileList | File[]) => {
    const location = preparedCameraLocationRef.current;
    if (!location) {
      const message = 'Obtenha a localização antes de abrir a câmera.';
      setCameraLocationError(message);
      toast({ variant: 'destructive', title: 'Foto não anexada', description: message });
      return;
    }
    const stamp: DailyReportPhotoStamp = {
      capturedAt: new Date().toISOString(),
      location,
      placeLabel: cameraPlaceLabel,
    };
    preparedCameraLocationRef.current = undefined;
    setCameraCaptureState('idle');
    await uploadFiles(files, stamp);
  }, [cameraPlaceLabel, uploadFiles]);

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
    cameraCaptureState,
    cameraLocationError,
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
    handleCameraFiles,
    prepareCameraCapture,
    updatePhoto,
    removePhoto,
  };
}
