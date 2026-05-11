import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  Upload, Download, Printer, CheckCircle2, Lock, XCircle, History, ChevronDown,
} from 'lucide-react';
import type { Project, Additive as AdditiveModel, AdditiveStatus } from '@/types/project';
import { STATUS_BADGE, STATUS_LABEL } from './types';
import type { RefObject } from 'react';

interface Props {
  project: Project;
  active: AdditiveModel | null;
  status: AdditiveStatus;
  bdi: number;
  globalDiscount: number;
  isLocked: boolean;
  fileRef: RefObject<HTMLInputElement>;
  undoButton?: React.ReactNode;
  onChangeBdi: (value: string) => void;
  onChangeGlobalDiscount: (value: string) => void;
  onFileSelected: (f: File | null) => void;
  onUseSynthetic: () => void;
  onContract: () => void;
  onExportExcel: () => void;
  onExportSyntheticComplete: () => void;
  onExportNewServices: () => void;
  onExportCalculationMemory: () => void;
  onExportPdf: () => void;
  onExportSyntheticCompletePdf: () => void;
  onExportNewServicesPdf: () => void;
  onExportCalculationMemoryPdf: () => void;
  onExportPackageExcel: () => void;
  onExportPackagePdf: () => void;
  onOpenHistory: () => void;
}

export default function AdditiveHeader({
  project, active, status, bdi, globalDiscount, isLocked, fileRef, undoButton,
  onChangeBdi, onChangeGlobalDiscount, onFileSelected, onUseSynthetic,
  onContract, onExportExcel, onExportSyntheticComplete, onExportNewServices,
  onExportCalculationMemory, onExportPdf,
  onExportSyntheticCompletePdf, onExportNewServicesPdf, onExportCalculationMemoryPdf,
  onExportPackageExcel, onExportPackagePdf,
  onOpenHistory,
}: Props) {
  const lastLog = active ? (project.auditLogs ?? [])
    .filter(l => l.entityType === 'additive' && l.entityId === active.id)
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0] : undefined;

  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Aditivo {active ? `— ${active.name}` : ''}
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Importação de planilhas de aditivo contratual (Sintética + Analítica).
        </p>
        {active && (
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={STATUS_BADGE[status]}>
              {status === 'aprovado' && <CheckCircle2 className="w-3 h-3 mr-1" />}
              {status === 'em_analise' && <Lock className="w-3 h-3 mr-1" />}
              {status === 'reprovado' && <XCircle className="w-3 h-3 mr-1" />}
              {STATUS_LABEL[status]}
            </Badge>
            {(active.version ?? 0) > 0 && (
              <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-300">
                v{active.version}
              </Badge>
            )}
            {active.approvedAt && (
              <span className="text-[11px] text-muted-foreground">
                Aprovado em {new Date(active.approvedAt).toLocaleDateString('pt-BR')}
                {active.approvedBy ? ` por ${active.approvedBy}` : ''}
              </span>
            )}
            {lastLog && (
              <span className="text-[11px] text-muted-foreground">
                Última alteração: {new Date(lastLog.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {lastLog.userName ? ` · ${lastLog.userName}` : ''}
              </span>
            )}
            {active.reviewNotes && (
              <span className="text-[11px] text-muted-foreground italic">"{active.reviewNotes}"</span>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {undoButton}
        {active && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded border bg-card">
            <span className="text-xs text-muted-foreground">BDI (%):</span>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={bdi}
              disabled={isLocked}
              onChange={e => onChangeBdi(e.target.value)}
              className="h-7 w-20 text-xs no-spinner"
            />
          </div>
        )}
        {active && (
          <div
            className="flex items-center gap-1.5 px-2 py-1 rounded border bg-card"
            title="Desconto global aplicado APENAS aos novos serviços (estudo do aditivo)."
          >
            <span className="text-xs text-muted-foreground">Desconto Licit. (%):</span>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={globalDiscount}
              disabled={isLocked}
              onChange={e => onChangeGlobalDiscount(e.target.value)}
              className="h-7 w-20 text-xs no-spinner"
            />
          </div>
        )}
        <input
          ref={fileRef} type="file" accept=".xlsx,.xls"
          className="hidden"
          onChange={e => onFileSelected(e.target.files?.[0] ?? null)}
        />
        <Button variant="default" size="sm" onClick={() => fileRef.current?.click()}>
          <Upload className="w-4 h-4 mr-1" /> Importar Excel
        </Button>
        {(project.budgetItems ?? []).some(b => b.source === 'sintetica') && (
          <Button
            variant="outline"
            size="sm"
            onClick={onUseSynthetic}
            title="Cria um aditivo em rascunho a partir da Sintética já importada na Medição/EAP"
          >
            <Upload className="w-4 h-4 mr-1" /> Usar Sintética da Medição
          </Button>
        )}
        {active && (active.status === 'aprovado' || active.isContracted) && (
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/90"
            onClick={onContract}
            disabled={!!active.isContracted}
            title={active.isContracted
              ? 'Aditivo já contratado — novos serviços integrados ao projeto.'
              : 'Marca o aditivo como contratado e integra os novos serviços à EAP/Medição.'}
          >
            <CheckCircle2 className="w-4 h-4 mr-1" />
            {active.isContracted ? 'Aditivo Contratado' : 'Marcar como Contratado'}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={!active}>
              <Download className="w-4 h-4 mr-1" /> Exportar Excel
              <ChevronDown className="w-3 h-3 ml-1 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void onExportSyntheticComplete(); }}>
              Exportar Sintética Completa
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void onExportNewServices(); }}>
              Exportar Novas Composições
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void onExportCalculationMemory(); }}>
              Exportar Memória de Cálculo
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void onExportPackageExcel(); }}>
              Exportar Pacote Completo
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={!active}>
              <Printer className="w-4 h-4 mr-1" /> Imprimir / PDF
              <ChevronDown className="w-3 h-3 ml-1 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void onExportSyntheticCompletePdf(); }}>
              Sintética Completa (PDF)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void onExportNewServicesPdf(); }}>
              Novas Composições (PDF)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void onExportCalculationMemoryPdf(); }}>
              Memória de Cálculo (PDF)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void onExportPdf(); }}>
              PDF Completo (com analítica)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void onExportPackagePdf(); }}>
              Pacote Completo (PDF)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="sm" disabled={!active} onClick={onOpenHistory}>
          <History className="w-4 h-4 mr-1" /> Histórico
        </Button>
      </div>
    </header>
  );
}
