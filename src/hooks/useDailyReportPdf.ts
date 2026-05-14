import { useCallback } from 'react';
import { toast } from 'sonner';
import type {
  DailyReport as DailyReportEntry,
  DailyReportAttachment,
  Project,
  TeamDefinition,
} from '@/types/project';
import { summarizeDailyReportsForPeriod } from '@/lib/dailyReportSummary';
import { loadCompanyLogoForPdf } from '@/lib/companyBranding';
import { resolvePhotoUrl } from '@/lib/photoUrl';
import {
  GENERAL_TASK_VALUE,
  WEATHER_OPTIONS,
  WORK_OPTIONS,
  formatBR,
  shortTaskName,
  todayISO,
} from '@/components/dailyReport/dailyReportFormat';
import { collectProductionForDate } from '@/hooks/useDailyReportProduction';
import type { ProductionEntry } from '@/components/dailyReport/types';
import type jsPDFType from 'jspdf';

type AutoTableFn = typeof import('jspdf-autotable').default;

// jsPDF/autoTable são carregados sob demanda (~300 kB) só ao gerar PDF.
async function loadPdfDeps(): Promise<{ jsPDF: typeof jsPDFType; autoTable: AutoTableFn }> {
  const [jsPDFMod, autoTableMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const jsPDF = (jsPDFMod as any).default || (jsPDFMod as any).jsPDF || jsPDFMod;
  const autoTable = (autoTableMod as any).default || (autoTableMod as any).autoTable || autoTableMod;
  return { jsPDF, autoTable };
}

export interface UseDailyReportPdfArgs {
  project: Project;
  selectedDate: string;
  currentReport: DailyReportEntry;
  activePeriod: { id: string; label: string; startDate: string; endDate: string } | null | undefined;
  periodDates: string[];
  periodSummary: unknown;
  production: ProductionEntry[];
  grouped: unknown;
  summary: unknown;
  photos: DailyReportAttachment[];
  photosByTask: Map<string, number>;
  teamByCode: Map<string, TeamDefinition>;
  teamDisplay: (team: TeamDefinition | undefined, fallback?: string) => string;
  dateMembership: unknown;
  measurementFilter: string;
}

export function useDailyReportPdf(args: UseDailyReportPdfArgs) {
  const { project, selectedDate, activePeriod, periodDates, teamByCode, teamDisplay } = args;

  /** Carrega URL como dataURL (necessário para embed no PDF). */
  const fetchAsDataURL = async (url: string): Promise<string | null> => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  /**
   * Carrega a imagem respeitando orientação EXIF e devolve dataURL JPEG
   * com largura/altura naturais já corrigidas. Usa createImageBitmap quando
   * disponível (aplica EXIF) com fallback para <img> + canvas.
   */
  const loadOrientedImage = async (
    src: string,
    mimeType?: string,
  ): Promise<{ dataUrl: string; width: number; height: number } | null> => {
    try {
      let bitmapW = 0, bitmapH = 0;
      let canvas: HTMLCanvasElement;

      // Caminho preferido: createImageBitmap com correção EXIF
      if (typeof createImageBitmap === 'function') {
        const res = await fetch(src);
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions).catch(async () => {
          // Safari antigos: sem opção EXIF — usa fallback
          return await createImageBitmap(blob);
        });
        bitmapW = bmp.width; bitmapH = bmp.height;
        canvas = document.createElement('canvas');
        canvas.width = bitmapW; canvas.height = bitmapH;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        bmp.close?.();
      } else {
        // Fallback: <img> (em navegadores modernos respeita EXIF ao desenhar)
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const i = new Image();
          i.crossOrigin = 'anonymous';
          i.onload = () => resolve(i);
          i.onerror = () => reject(new Error('img load fail'));
          i.src = src;
        });
        bitmapW = img.naturalWidth; bitmapH = img.naturalHeight;
        canvas = document.createElement('canvas');
        canvas.width = bitmapW; canvas.height = bitmapH;
        canvas.getContext('2d')!.drawImage(img, 0, 0);
      }

      // Reduz dimensão máxima para um PDF leve (longest side <= 1600px)
      const MAX = 1600;
      const longest = Math.max(bitmapW, bitmapH);
      if (longest > MAX) {
        const scale = MAX / longest;
        const dw = Math.round(bitmapW * scale);
        const dh = Math.round(bitmapH * scale);
        const c2 = document.createElement('canvas');
        c2.width = dw; c2.height = dh;
        c2.getContext('2d')!.drawImage(canvas, 0, 0, dw, dh);
        canvas = c2;
        bitmapW = dw; bitmapH = dh;
      }

      const isPng = (mimeType || '').includes('png');
      const dataUrl = canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.85);
      return { dataUrl, width: bitmapW, height: bitmapH };
    } catch {
      return null;
    }
  };

  // ───── PDF ─────
  /**
   * Gera o PDF do Diário de Obra.
   * - mode='day': apenas a data atualmente selecionada.
   * - mode='period': todos os dias do período da medição filtrada (ou da data atual, como fallback).
   */
  const generatePDF = useCallback(async (mode: 'day' | 'period') => {
    // Silencia warning de função não usada no PDF atual (mantido para futura paridade).
    void fetchAsDataURL;
    const { jsPDF, autoTable } = await loadPdfDeps();
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 12;
    const footerReserved = 14;

    // Define escopo (datas e título contextual)
    let dates: string[];
    let scopeTitle: string;
    let fileName: string;
    const projectName = project?.name || 'Obra';
    const safeName = projectName.replace(/[^a-z0-9]+/gi, '_') || 'Obra';
    const safeSelectedDate = selectedDate || todayISO();

    if (mode === 'period' && activePeriod && periodDates.length > 0) {
      dates = periodDates;
      const isDraft = activePeriod.id === 'draft';
      scopeTitle = isDraft
        ? 'DIÁRIO DE OBRA — MEDIÇÃO EM PREPARAÇÃO'
        : `DIÁRIO DE OBRA — ${activePeriod.label.toUpperCase()}`;
      fileName = isDraft
        ? `Diario_Obra_Medicao_Preparacao_${safeName}.pdf`
        : `Diario_Obra_${activePeriod.label.replace(/[^a-z0-9]+/gi, '_')}_${safeName}.pdf`;
    } else {
      dates = [safeSelectedDate];
      scopeTitle = `DIÁRIO DE OBRA — ${formatBR(safeSelectedDate)}`;
      fileName = `Diario_Obra_${safeName}_${safeSelectedDate}.pdf`;
    }

    // Snapshot da medição (para cabeçalho)
    const ci = project.contractInfo || {};
    const periodoStr = mode === 'period' && activePeriod
      ? `${formatBR(activePeriod.startDate)} a ${formatBR(activePeriod.endDate)}`
      : formatBR(safeSelectedDate);
    const issueStr = formatBR(todayISO());

    // Logo da empresa (canto superior esquerdo)
    const logo = await loadCompanyLogoForPdf().catch(() => null);
    const logoTargetW = 28; // mm
    let logoH = 0;
    if (logo) {
      const ratio = logo.width / logo.height;
      logoH = logoTargetW / ratio;
      try { doc.addImage(logo.dataUrl, 'PNG', margin, margin, logoTargetW, logoH, undefined, 'FAST'); } catch {}
    }

    // ───── Cabeçalho ─────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(scopeTitle, pageW / 2, margin + 4, { align: 'center' });

    let y = Math.max(margin + 7, margin + logoH + 1);
    const usable = pageW - margin * 2;

    const headerColWidths = [usable * 0.18, usable * 0.32, usable * 0.18, usable * 0.32];
    const headerRows: [string, string, string, string][] = [
      ['Obra:', projectName || '-', 'Período:', periodoStr],
      ['Contratante:', ci.contractor || '-', 'Contratada:', ci.contracted || '-'],
      ['Local/Município:', ci.location || '-', 'Nº Contrato:', ci.contractNumber || '-'],
      ['Objeto:', ci.contractObject || '-', 'Nº ART:', ci.artNumber || '-'],
      ['Fonte de orçamento:', ci.budgetSource || '-', 'Data emissão:', issueStr],
      ['BDI %:', ci.bdiPercent != null ? String(ci.bdiPercent) : '-', '', ''],
    ];
    autoTable(doc, {
      startY: y,
      body: headerRows,
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.4, overflow: 'linebreak', valign: 'middle', lineColor: [180, 180, 180], lineWidth: 0.15, textColor: 20 },
      columnStyles: {
        0: { cellWidth: headerColWidths[0], fontStyle: 'bold', fillColor: [243, 244, 246] },
        1: { cellWidth: headerColWidths[1] },
        2: { cellWidth: headerColWidths[2], fontStyle: 'bold', fillColor: [243, 244, 246] },
        3: { cellWidth: headerColWidths[3] },
      },
      margin: { left: margin, right: margin },
      tableWidth: usable,
    });
    y = ((doc as any).lastAutoTable?.finalY ?? y) + 3;

    // ───── Resumo geral do período ─────
    const periodSum = summarizeDailyReportsForPeriod(
      project,
      dates[0],
      dates[dates.length - 1],
    );

    // Totaliza equipes / ocorrências / impedimentos no período
    let totalTeams = 0;
    let totalOccurrences = 0;
    let totalImpediments = 0;
    const reportsByDate = new Map<string, DailyReportEntry>();
    (project.dailyReports || []).forEach(r => reportsByDate.set(r.date, r));
    dates.forEach(d => {
      const r = reportsByDate.get(d);
      if (!r) return;
      totalTeams += (r.teamsPresent || []).reduce((a, t) => a + (t.count || 0), 0);
      if (r.occurrences?.trim()) totalOccurrences++;
      if (r.impediments?.trim()) totalImpediments++;
    });

    const cards: [string, string][] = [
      ['Total de dias', String(periodSum.totalDays)],
      ['Diários preench.', String(periodSum.filledReports)],
      ['Diários pendentes', String(periodSum.missingReports)],
      ['Dias c/ produção', String(periodSum.productionDays)],
      ['Dias s/ produção', String(periodSum.noProductionDays)],
      ['Dias c/ impedim.', String(periodSum.impedimentDays)],
      ['Equipes (qtd)', String(totalTeams)],
      ['Ocorrências', String(totalOccurrences)],
    ];
    const cardH = 9;
    const perRow = 4;
    const cardW = usable / perRow;
    for (let i = 0; i < cards.length; i++) {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const cx = margin + col * cardW;
      const cy = y + row * cardH;
      doc.setDrawColor(180); doc.setLineWidth(0.15);
      doc.setFillColor(249, 250, 251);
      doc.rect(cx, cy, cardW, cardH, 'FD');
      doc.setTextColor(110); doc.setFont('helvetica', 'normal'); doc.setFontSize(6.6);
      doc.text(cards[i][0], cx + 2, cy + 3.4);
      doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text(cards[i][1], cx + cardW - 2, cy + 6.6, { align: 'right' });
    }
    y += Math.ceil(cards.length / perRow) * cardH + 3;

    // ───── Pendências do Período ─────
    const pendingDates = periodSum.entries.filter(e => e.status === 'pending').map(e => e.date);
    const prodNoReport = periodSum.productionWithoutReportDates;
    const impedimentDates = periodSum.entries.filter(e => e.hasImpediment).map(e => e.date);
    const hasAnyPending = pendingDates.length || prodNoReport.length || impedimentDates.length;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(20);
    if (y + 12 > pageH - footerReserved) { doc.addPage(); y = margin; }
    doc.text('Pendências do Período', margin, y); y += 4;

    if (!hasAnyPending) {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor(90);
      doc.text('Não há pendências no período.', margin, y); y += 6;
    } else {
      const pendRows: [string, string][] = [];
      if (pendingDates.length) pendRows.push(['Sem diário', pendingDates.map(formatBR).join(', ')]);
      if (prodNoReport.length) pendRows.push(['Produção sem diário', prodNoReport.map(formatBR).join(', ')]);
      if (impedimentDates.length) pendRows.push(['Com impedimento', impedimentDates.map(formatBR).join(', ')]);
      autoTable(doc, {
        startY: y,
        body: pendRows,
        theme: 'grid',
        styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.3, overflow: 'linebreak', lineColor: [200, 200, 200], lineWidth: 0.12 },
        columnStyles: {
          0: { cellWidth: usable * 0.22, fontStyle: 'bold', fillColor: [254, 243, 199] },
          1: { cellWidth: usable * 0.78 },
        },
        margin: { left: margin, right: margin },
      });
      y = ((doc as any).lastAutoTable?.finalY ?? y) + 4;
    }

    // ───── Conteúdo de cada dia ─────
    const STATUS_LABEL: Record<string, string> = {
      filled: 'Preenchido',
      pending: 'Pendente',
      noProduction: 'Produção sem diário',
      impediment: 'Com impedimento',
    };

    const ensureSpace = (h: number) => {
      if (y + h > pageH - footerReserved) { doc.addPage(); y = margin; }
    };

    for (let idx = 0; idx < dates.length; idx++) {
      const dateISO = dates[idx];
      const entry = periodSum.entries.find(e => e.date === dateISO);
      const report = reportsByDate.get(dateISO);
      const dayProduction = collectProductionForDate(project, dateISO);

      // Quebra de página a cada novo dia (exceto o primeiro), para visual limpo.
      if (idx > 0) { doc.addPage(); y = margin; }
      else { ensureSpace(20); }

      // Cabeçalho do dia
      doc.setFillColor(31, 41, 55); // slate-800
      doc.setTextColor(255);
      doc.rect(margin, y, usable, 7, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text(`Diário de Obra — ${formatBR(dateISO)}`, margin + 2, y + 4.8);
      const statusLabel = entry ? STATUS_LABEL[entry.status] : 'Pendente';
      doc.setFontSize(8);
      doc.text(`Status: ${statusLabel}`, margin + usable - 2, y + 4.8, { align: 'right' });
      doc.setTextColor(20);
      y += 9;

      // Aviso de pendência / produção sem diário
      const hasReport = !!report;
      const hasProd = dayProduction.length > 0;
      if (!hasReport) {
        doc.setFillColor(254, 243, 199);
        doc.setDrawColor(245, 158, 11); doc.setLineWidth(0.2);
        doc.rect(margin, y, usable, 6, 'FD');
        doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(120, 53, 15);
        const msg = hasProd
          ? 'Produção apontada, mas diário não preenchido.'
          : 'Diário pendente de preenchimento.';
        doc.text(msg, margin + 2, y + 4);
        doc.setTextColor(20);
        y += 8;
      }

      // Cabeçalho do dia (responsável / clima / condição)
      const weatherLabel = report?.weather === 'outro'
        ? `Outro: ${report?.weatherOther || ''}`
        : (WEATHER_OPTIONS.find(w => w.value === report?.weather)?.label || '—');
      const workLabel = report?.workCondition === 'outro'
        ? `Outro: ${report?.workConditionOther || ''}`
        : (WORK_OPTIONS.find(w => w.value === report?.workCondition)?.label || '—');

      autoTable(doc, {
        startY: y,
        body: [
          ['Responsável:', report?.responsible || '—', 'Clima:', weatherLabel],
          ['Condição:', workLabel, 'Apontamentos:', String(dayProduction.length)],
        ],
        theme: 'grid',
        styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.2, lineColor: [200, 200, 200], lineWidth: 0.12 },
        columnStyles: {
          0: { cellWidth: usable * 0.16, fontStyle: 'bold', fillColor: [243, 244, 246] },
          1: { cellWidth: usable * 0.34 },
          2: { cellWidth: usable * 0.16, fontStyle: 'bold', fillColor: [243, 244, 246] },
          3: { cellWidth: usable * 0.34 },
        },
        margin: { left: margin, right: margin },
      });
      y = ((doc as any).lastAutoTable?.finalY ?? y) + 2;

      // Equipe presente
      const teams = report?.teamsPresent || [];
      ensureSpace(10);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
      doc.text('Equipe presente', margin, y); y += 1.5;
      if (teams.length === 0) {
        autoTable(doc, {
          startY: y,
          body: [['—']],
          theme: 'grid',
          styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.2, textColor: 120, lineColor: [220, 220, 220], lineWidth: 0.12 },
          margin: { left: margin, right: margin },
        });
      } else {
        autoTable(doc, {
          startY: y,
          head: [['Equipe', 'Qtd.', 'Observação']],
          body: teams.map(t => {
            const label = teamDisplay(t.teamCode ? teamByCode.get(t.teamCode) : undefined, t.role || t.name);
            return [label, String(t.count ?? 1), t.notes || ''];
          }),
          theme: 'grid',
          headStyles: { fillColor: [55, 65, 81], textColor: 255, fontSize: 7.5 },
          styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.2, lineColor: [220, 220, 220], lineWidth: 0.12 },
          columnStyles: {
            0: { cellWidth: usable * 0.40 },
            1: { cellWidth: usable * 0.10, halign: 'center' },
            2: { cellWidth: usable * 0.50 },
          },
          margin: { left: margin, right: margin },
        });
      }
      y = ((doc as any).lastAutoTable?.finalY ?? y) + 2;

      // Equipamentos
      const equipments = report?.equipment || [];
      ensureSpace(10);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
      doc.text('Equipamentos', margin, y); y += 1.5;
      if (equipments.length === 0) {
        autoTable(doc, {
          startY: y,
          body: [['—']],
          theme: 'grid',
          styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.2, textColor: 120, lineColor: [220, 220, 220], lineWidth: 0.12 },
          margin: { left: margin, right: margin },
        });
      } else {
        autoTable(doc, {
          startY: y,
          head: [['Equipamento', 'Qtd.', 'Observação']],
          body: equipments.map(e => [e.name || '—', String(e.count ?? 1), e.notes || '']),
          theme: 'grid',
          headStyles: { fillColor: [55, 65, 81], textColor: 255, fontSize: 7.5 },
          styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.2, lineColor: [220, 220, 220], lineWidth: 0.12 },
          columnStyles: {
            0: { cellWidth: usable * 0.40 },
            1: { cellWidth: usable * 0.10, halign: 'center' },
            2: { cellWidth: usable * 0.50 },
          },
          margin: { left: margin, right: margin },
        });
      }
      y = ((doc as any).lastAutoTable?.finalY ?? y) + 2;

      // Produção executada
      ensureSpace(10);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
      doc.text('Produção executada', margin, y); y += 1.5;
      if (dayProduction.length === 0) {
        autoTable(doc, {
          startY: y,
          body: [['Nenhuma produção apontada nesta data.']],
          theme: 'grid',
          styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.2, textColor: 120, fontStyle: 'italic', lineColor: [220, 220, 220], lineWidth: 0.12 },
          margin: { left: margin, right: margin },
        });
      } else {
        autoTable(doc, {
          startY: y,
          head: [['Capítulo', 'Subcapítulo', 'Tarefa', 'Und.', 'Qtd. exec.', 'Observação']],
          body: dayProduction.map(p => [
            `${p.chapterNumber} ${p.chapterName}`,
            p.subChapterName ? `${p.subChapterNumber} ${p.subChapterName}` : '',
            p.taskName,
            p.unit || 'un',
            p.actualQuantity.toFixed(2),
            p.notes || '',
          ]),
          theme: 'grid',
          headStyles: { fillColor: [55, 65, 81], textColor: 255, fontSize: 7.3 },
          styles: { font: 'helvetica', fontSize: 7.3, cellPadding: 1.2, lineColor: [220, 220, 220], lineWidth: 0.12, overflow: 'linebreak' },
          columnStyles: {
            0: { cellWidth: usable * 0.18 },
            1: { cellWidth: usable * 0.18 },
            2: { cellWidth: usable * 0.28 },
            3: { cellWidth: usable * 0.07, halign: 'center' },
            4: { cellWidth: usable * 0.10, halign: 'right' },
            5: { cellWidth: usable * 0.19 },
          },
          margin: { left: margin, right: margin },
          // Repetir cabeçalho ao quebrar página
          showHead: 'everyPage',
        });
      }
      y = ((doc as any).lastAutoTable?.finalY ?? y) + 2;

      // Ocorrências / Impedimentos / Observações
      const longBlock = (title: string, value?: string) => {
        ensureSpace(14);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
        doc.text(title, margin, y); y += 1.5;
        autoTable(doc, {
          startY: y,
          body: [[value?.trim() ? value : '—']],
          theme: 'grid',
          styles: {
            font: 'helvetica', fontSize: 8, cellPadding: 1.6,
            textColor: value?.trim() ? 20 : 120,
            fontStyle: value?.trim() ? 'normal' : 'italic',
            lineColor: [220, 220, 220], lineWidth: 0.12, overflow: 'linebreak',
            minCellHeight: 8,
          },
          margin: { left: margin, right: margin },
        });
        y = ((doc as any).lastAutoTable?.finalY ?? y) + 2;
      };
      longBlock('Ocorrências', report?.occurrences);
      longBlock('Impedimentos', report?.impediments);
      longBlock('Observações', report?.observations);

      // ───── Fotos do dia ─────
      const dayPhotos = (report?.attachments || []).filter(a => (a.type ?? 'image') === 'image');
      if (dayPhotos.length > 0) {
        ensureSpace(14);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(20);
        doc.text(`Fotos da Obra (${dayPhotos.length})`, margin, y); y += 3;

        // Agrupar por tarefa mantendo numeração geral sequencial
        const byTask = new Map<string, { taskShort: string; phaseChain?: string; photos: DailyReportAttachment[] }>();
        const taskOrder: string[] = [];
        dayPhotos.forEach(p => {
          const k = p.taskId || GENERAL_TASK_VALUE;
          if (!byTask.has(k)) {
            taskOrder.push(k);
            byTask.set(k, {
              taskShort: k === GENERAL_TASK_VALUE ? 'Geral' : shortTaskName(p.taskName),
              phaseChain: p.phaseChain,
              photos: [],
            });
          }
          byTask.get(k)!.photos.push(p);
        });

        const cols = 2;
        const gap = 4;
        const cardW = (usable - gap * (cols - 1)) / cols;
        const imgBoxH = 55;       // altura máxima da imagem (mm)
        const headerH = 4.6;
        const captionMaxH = 6.8;  // ~2 linhas
        const metaH = 3.4;
        const cardPad = 2;
        const cardH = headerH + imgBoxH + captionMaxH + metaH + cardPad * 2 + 1;

        const totalPad = dayPhotos.length.toString().length;
        let photoIndex = 0;

        for (const k of taskOrder) {
          const group = byTask.get(k)!;
          // Cabeçalho discreto da atividade (curto)
          ensureSpace(6 + cardH);
          doc.setFont('helvetica', 'bold'); doc.setFontSize(7.6); doc.setTextColor(55, 65, 81);
          doc.text(`Atividade: ${group.taskShort}`, margin, y);
          y += 3.2;
          doc.setTextColor(20);

          for (let pIdx = 0; pIdx < group.photos.length; pIdx += cols) {
            ensureSpace(cardH + 2);
            const rowPhotos = group.photos.slice(pIdx, pIdx + cols);
            const rowTopY = y;

            for (let c = 0; c < rowPhotos.length; c++) {
              const ph = rowPhotos[c];
              photoIndex += 1;
              const x = margin + c * (cardW + gap);
              const cardTop = rowTopY;

              // Card border
              doc.setDrawColor(220); doc.setLineWidth(0.2);
              doc.rect(x, cardTop, cardW, cardH);

              // Header: "Foto NN — Nome curto"
              const num = String(photoIndex).padStart(Math.max(2, totalPad), '0');
              const shortName = group.taskShort;
              const titleRaw = `Foto ${num} — ${shortName}`;
              doc.setFont('helvetica', 'bold'); doc.setFontSize(7.4); doc.setTextColor(31, 41, 55);
              const titleLines = doc.splitTextToSize(titleRaw, cardW - cardPad * 2);
              doc.text(titleLines[0], x + cardPad, cardTop + cardPad + 2.6);

              // Image area
              const imgTop = cardTop + cardPad + headerH;
              const imgAreaW = cardW - cardPad * 2;
              const imgAreaH = imgBoxH;

              let drew = false;
              const srcUrl = await resolvePhotoUrl(ph);
              if (srcUrl) {
                const oriented = await loadOrientedImage(srcUrl, ph.mimeType);
                if (oriented) {
                  // Encaixa preservando proporção (sem distorcer)
                  const ratio = oriented.width / oriented.height;
                  let drawW = imgAreaW;
                  let drawH = drawW / ratio;
                  if (drawH > imgAreaH) {
                    drawH = imgAreaH;
                    drawW = drawH * ratio;
                  }
                  const dx = x + cardPad + (imgAreaW - drawW) / 2;
                  const dy = imgTop + (imgAreaH - drawH) / 2;
                  try {
                    const fmt = oriented.dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
                    doc.addImage(oriented.dataUrl, fmt, dx, dy, drawW, drawH, undefined, 'FAST');
                    drew = true;
                  } catch { /* fallback below */ }
                }
              }
              if (!drew) {
                doc.setDrawColor(230); doc.rect(x + cardPad, imgTop, imgAreaW, imgAreaH);
                doc.setFontSize(6.5); doc.setTextColor(150);
                doc.text('Imagem indisponível', x + cardPad + imgAreaW / 2, imgTop + imgAreaH / 2, { align: 'center' });
                doc.setTextColor(20);
              }

              // Observação
              const capTop = imgTop + imgAreaH + 2;
              doc.setFont('helvetica', 'normal'); doc.setFontSize(6.6); doc.setTextColor(60);
              const capRaw = ph.caption?.trim() ? `Observação: ${ph.caption.trim()}` : 'Observação: —';
              const capLines = doc.splitTextToSize(capRaw, imgAreaW).slice(0, 2);
              doc.text(capLines, x + cardPad, capTop + 1.6);

              // Meta: data, hora, atividade curta, qtd
              const metaTop = capTop + captionMaxH;
              doc.setFontSize(5.8); doc.setTextColor(130);
              const when = ph.uploadedAt ? new Date(ph.uploadedAt) : null;
              const dateStr = when ? when.toLocaleDateString('pt-BR') : '';
              const timeStr = when ? when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
              const qtyStr = (ph.quantity != null && ph.unit) ? ` — ${ph.quantity} ${ph.unit}` : '';
              const metaParts = [
                [dateStr, timeStr].filter(Boolean).join(', '),
                shortName,
              ].filter(Boolean).join(' — ') + qtyStr;
              const metaLines = doc.splitTextToSize(metaParts, imgAreaW).slice(0, 1);
              doc.text(metaLines, x + cardPad, metaTop + 1.4);
              doc.setTextColor(20);
            }
            y = rowTopY + cardH + 2;
          }
          y += 1;
        }
      }
    }

    // ───── Rodapé fixo em todas as páginas ─────
    const total = doc.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      doc.setPage(i);
      const footerTop = pageH - margin - 10;
      doc.setDrawColor(180); doc.setLineWidth(0.2);
      doc.line(margin, footerTop, pageW - margin, footerTop);

      doc.setTextColor(80);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.4);
      doc.text('K. C. BUENO DE GODOY OLIVEIRA LTDA', pageW / 2, footerTop + 2.8, { align: 'center' });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6);
      doc.text(
        'CNPJ: 39.973.085/0001-20  •  Rua Getúlio Vargas, 2533, São Cristóvão  •  Porto Velho/RO',
        pageW / 2, footerTop + 5.4, { align: 'center' }
      );

      doc.setFontSize(6); doc.setTextColor(120);
      const leftFoot = mode === 'period' && activePeriod
        ? `${scopeTitle} — ${project.name || ''}`
        : `Diário de Obra — ${project.name || ''}`;
      doc.text(leftFoot, margin, pageH - 1.5);
      doc.text(`Página ${i}/${total}`, pageW - margin, pageH - 1.5, { align: 'right' });
      doc.setTextColor(0);
    }

    doc.save(fileName);
  }, [project, activePeriod, periodDates, selectedDate, teamByCode, teamDisplay]);

  const handlePrintDay = useCallback(async () => {
    try {
      await generatePDF('day');
    } catch (e) {
      console.error('Erro ao gerar PDF do dia (Diário de Obra)', e);
      toast.error('Falha ao gerar PDF do dia. Verifique o console para detalhes.');
    }
  }, [generatePDF]);
  const handlePrintPeriod = useCallback(async () => {
    try {
      await generatePDF('period');
    } catch (e) {
      console.error('Erro ao gerar PDF do período (Diário de Obra)', e);
      toast.error('Falha ao gerar PDF do período. Verifique o console para detalhes.');
    }
  }, [generatePDF]);

  return { handlePrintDay, handlePrintPeriod };
}
