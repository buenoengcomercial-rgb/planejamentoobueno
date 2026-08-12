import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import type { Additive as AdditiveModel } from '@/types/project';
import { fmtBRL, fmtPct } from './types';

interface Totals {
  totalContratadoOriginal: number;
  totalSuprimido: number;
  totalAcrescido: number;
  valorFinal: number;
  percentSupressao: number;
  percentAcrescimo: number;
  limitStatus: 'ok' | 'warn' | 'error' | string;
  limitPercent: number;
}

interface Props {
  active: AdditiveModel;
  totals: Totals;
  isLocked: boolean;
  onChangeLimit: (n: number) => void;
}

export default function AdditiveTotalsBlock({ active, totals, isLocked, onChangeLimit }: Props) {
  return (
    <Card className="p-4 space-y-4">
      <div>
        <h3 className="text-sm font-bold mb-2 text-primary">TOTAL GERAL</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-[11px] text-muted-foreground">Total contratado original</div>
            <div className="font-semibold">{fmtBRL(totals.totalContratadoOriginal)}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">Total suprimido</div>
            <div className="font-semibold text-rose-700">
              {totals.totalSuprimido > 0 ? fmtBRL(-totals.totalSuprimido) : fmtBRL(0)}
            </div>
            <div className="mt-3 text-[11px] text-muted-foreground">% Supressão</div>
            <div className="font-semibold text-rose-700">{fmtPct(totals.percentSupressao)}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">Total acrescido (geral)</div>
            <div className="font-semibold text-emerald-700">{fmtBRL(totals.totalAcrescido)}</div>
            <div className="mt-3 text-[11px] text-muted-foreground">% Acréscimo</div>
            <div className="font-semibold text-emerald-700">{fmtPct(totals.percentAcrescimo)}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">Valor final</div>
            <div className="font-semibold">{fmtBRL(totals.valorFinal)}</div>
          </div>
        </div>
      </div>

      <div className="border-t pt-3">
        <h3 className="text-sm font-bold mb-2">LIMITE DE ADITIVO DA LICITAÇÃO</h3>
        <div className="flex flex-wrap items-end gap-4 text-xs">
          <div>
            <div className="text-[11px] text-muted-foreground">Limite (%)</div>
            <Input
              type="number" step="0.5" min={0}
              value={active.aditivoLimitPercent ?? 50}
              disabled={isLocked}
              onChange={e => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v) || v < 0) return;
                onChangeLimit(v);
              }}
              className="h-8 w-24 text-xs no-spinner"
            />
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">Status</div>
            <Badge
              variant="outline"
              className={
                totals.limitStatus === 'ok'
                  ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                  : 'bg-amber-100 text-amber-800 border-amber-300'
              }
            >
              {totals.limitStatus === 'ok' ? (
                <><CheckCircle2 className="w-3 h-3 mr-1" /> OK</>
              ) : (
                <><AlertTriangle className="w-3 h-3 mr-1" /> Revisar Limite</>
              )}
            </Badge>
          </div>
        </div>
      </div>
    </Card>
  );
}
