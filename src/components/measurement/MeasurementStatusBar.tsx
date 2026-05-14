import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  FileCheck2, Plus, Unlock, CheckCircle2, XCircle, Lock, Trash2, Send,
} from 'lucide-react';
import type { SavedMeasurement } from '@/types/project';
import { STATUS_LABEL, STATUS_CLASS, STATUS_DESCRIPTION } from '@/components/measurement/types';
import { fmtDateBR } from '@/components/measurement/measurementFormat';

interface MeasurementStatusBarProps {
  measurements: SavedMeasurement[];
  activeId: string;
  setActiveId: (id: string) => void;
  activeMeasurement: SavedMeasurement | null;
  isLocked: boolean;
  newMeasurementDraft: () => void;
  onConfirmGenerate: () => void;
  onConfirmEdit: () => void;
  onConfirmDelete: () => void;
  setStatus: (status: SavedMeasurement['status']) => void;
  validationHasBlocking: boolean;
  /** Quando informado, intercepta o clique em "Enviar p/ Fiscal" (ex.: para abrir confirmação). */
  onSendToReview?: () => void;
  /** Reenviar uma medição reprovada+ajustada para fiscalização. */
  onResendForReview?: () => void;
}

export default function MeasurementStatusBar({
  measurements,
  activeId,
  setActiveId,
  activeMeasurement,
  isLocked,
  newMeasurementDraft,
  onConfirmGenerate,
  onConfirmEdit,
  onConfirmDelete,
  setStatus,
  validationHasBlocking,
  onSendToReview,
  onResendForReview,
}: MeasurementStatusBarProps) {
  const nextNumber = (measurements[measurements.length - 1]?.number || 0) + 1;

  return (
    <Card className="print:hidden">
      <CardContent className="p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-2">
            Medições
          </span>

          {measurements.map(m => (
            <button
              key={m.id}
              onClick={() => setActiveId(m.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors flex items-center gap-1.5 ${
                activeId === m.id
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background hover:bg-muted/60 border-border'
              }`}
            >
              <span className="font-mono">{m.number}ª</span> Medição
              <span
                className={`text-[9px] uppercase px-1.5 py-0.5 rounded border ${STATUS_CLASS[m.status]} ${
                  activeId === m.id ? 'opacity-90' : ''
                }`}
              >
                {STATUS_LABEL[m.status]}
              </span>
            </button>
          ))}

          <button
            onClick={newMeasurementDraft}
            className={`px-3 py-1.5 rounded-md text-xs font-medium border border-dashed transition-colors flex items-center gap-1.5 ${
              activeId === 'live'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background hover:bg-muted/60 border-border text-muted-foreground'
            }`}
            title="Medição em preparação"
          >
            Preparando {nextNumber}ª Medição
          </button>

          <div className="ml-auto flex items-center gap-2">
            {!activeMeasurement && (
              <Button
                size="sm"
                variant="default"
                onClick={onConfirmGenerate}
                disabled={validationHasBlocking}
                title={validationHasBlocking
                  ? 'Existem erros de validação que impedem gerar a medição.'
                  : undefined}
              >
                <FileCheck2 className="w-4 h-4 mr-1" /> Gerar Medição
              </Button>
            )}
            {activeMeasurement && (
              <Button size="sm" variant="outline" onClick={newMeasurementDraft}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Continuar próxima medição
              </Button>
            )}
            {activeMeasurement && isLocked && (
              <>
                {activeMeasurement.status === 'generated' && (
                  <Button size="sm" variant="default" onClick={() => (onSendToReview ? onSendToReview() : setStatus('in_review'))}>
                    <Send className="w-4 h-4 mr-1" /> Enviar p/ Fiscal
                  </Button>
                )}
                {activeMeasurement.status === 'in_review' && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setStatus('approved')}>
                      <CheckCircle2 className="w-4 h-4 mr-1 text-success" /> Aprovar Medição
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setStatus('rejected')}>
                      <XCircle className="w-4 h-4 mr-1 text-destructive" /> Reprovar / Ajustar
                    </Button>
                  </>
                )}
                {activeMeasurement.status === 'rejected' && (
                  <Button size="sm" variant="default" onClick={onConfirmEdit}>
                    <Unlock className="w-4 h-4 mr-1" /> Editar Medição
                  </Button>
                )}
              </>
            )}
            {activeMeasurement && !isLocked && activeMeasurement.status === 'rejected' && (
              <Button size="sm" variant="default" onClick={onResendForReview}>
                <Send className="w-4 h-4 mr-1" /> Reenviar p/ Fiscal
              </Button>
            )}
            {activeMeasurement && (
              <Button size="sm" variant="ghost" onClick={onConfirmDelete}>
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            )}
          </div>
        </div>

        {/* Linha de status */}
        {activeMeasurement && (
          <div className="mt-3 flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
              <span className={`px-2 py-1 rounded border font-semibold ${STATUS_CLASS[activeMeasurement.status]}`}>
                {STATUS_LABEL[activeMeasurement.status]}
              </span>
              <span className="text-muted-foreground">
                Medição nº <strong className="text-foreground">{activeMeasurement.number}</strong> ·
                período {fmtDateBR(activeMeasurement.startDate)} a {fmtDateBR(activeMeasurement.endDate)} ·
                emitida em {fmtDateBR(activeMeasurement.issueDate)}
              </span>
            </div>
            <span className="flex items-center gap-1 text-muted-foreground">
              {isLocked && <Lock className="w-3.5 h-3.5" />}
              {STATUS_DESCRIPTION[activeMeasurement.status]}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
