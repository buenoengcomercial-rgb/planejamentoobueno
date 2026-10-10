import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { CAPTURE_KINDS, CAPTURE_LABELS, type CaptureKind } from '@/lib/dxfSnap';

interface Props {
  available: CaptureKind[]; enabled: boolean; tracking: boolean; kinds: CaptureKind[];
  onClose: () => void;
  onAccept: (enabled: boolean, tracking: boolean, kinds: CaptureKind[]) => void;
}

export default function PlanCaptureDialog({ available, enabled, tracking, kinds, onClose, onAccept }: Props) {
  const [draftEnabled, setEnabled] = useState(enabled);
  const [draftTracking, setTracking] = useState(tracking);
  const [draftKinds, setKinds] = useState(kinds);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="z-[70] max-w-[400px] gap-2 rounded-sm border-slate-400 bg-[#f1f2f3] p-3 text-xs" onPointerDownOutside={event => event.preventDefault()}>
      <DialogTitle className="text-sm font-medium">Capturas para máscaras</DialogTitle>
      <DialogDescription className="text-[11px]">{available.length ? 'Escolha as capturas identificadas na geometria DXF.' : 'Esta folha não oferece entidades identificáveis. A marcação livre continua disponível.'}</DialogDescription>
      {!!available.length && <p className="text-[11px] text-slate-600">Durante o traçado, aproxime o cursor da geometria. Perpendicular e Paralelo usam o último ponto marcado. Rastreamento mostra guias a partir desse ponto ou de uma captura adquirida.</p>}
      <div className="space-y-1 border-b border-slate-300 pb-2">
        <label className="flex items-center gap-2"><input type="checkbox" checked={draftEnabled} disabled={!available.length} onChange={event => setEnabled(event.target.checked)} />Ativar capturas</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={draftTracking} disabled={!available.length} onChange={event => setTracking(event.target.checked)} />Ativar rastreamento</label>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 border border-slate-300 bg-white p-2">{CAPTURE_KINDS.map(kind => {
        const supported = available.includes(kind);
        return <label key={kind} className={`flex items-center gap-2 ${supported && draftEnabled ? '' : 'text-slate-400'}`} title={supported ? `${CAPTURE_LABELS[kind]} — geometria reconhecida` : `${CAPTURE_LABELS[kind]} — geometria não identificada nesta planta`}>
          <input type="checkbox" checked={draftKinds.includes(kind) && supported} disabled={!supported || !draftEnabled} onChange={event => setKinds(previous => event.target.checked ? [...previous, kind] : previous.filter(item => item !== kind))} />{CAPTURE_LABELS[kind]}
        </label>;
      })}</div>
      <div className="flex items-center justify-between gap-1 border-t border-slate-300 pt-2">
        <Button className="h-7 rounded-sm px-2 text-xs" variant="outline" onClick={() => onAccept(draftEnabled, draftTracking, draftKinds)}>Confirmar</Button>
        <Button className="h-7 rounded-sm px-2 text-xs" variant="outline" onClick={() => setKinds([])}>Desmarcar todas</Button>
        <Button className="h-7 rounded-sm px-2 text-xs" variant="outline" onClick={onClose}>Cancelar</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
