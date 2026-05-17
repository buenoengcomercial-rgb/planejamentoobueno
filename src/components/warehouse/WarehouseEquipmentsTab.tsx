import { useState } from 'react';
import type { Project, Equipment, CustodyTerm, CustodyTermStatus } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2, FileDown, Undo2 } from 'lucide-react';
import { ensureWarehouse, addEquipment, removeEquipment, issueCustodyTerm, returnCustodyTerm } from '@/lib/warehouse';
import SignaturePad from './SignaturePad';
import { generateCustodyTermPdf } from './pdf';

interface Props { project: Project; onProjectChange: (next: Project) => void; }

export default function WarehouseEquipmentsTab({ project, onProjectChange }: Props) {
  const wh = ensureWarehouse(project).warehouse!;
  const [eq, setEq] = useState({ name: '', patrimony: '', serial: '', category: '' });
  const [showTerm, setShowTerm] = useState(false);
  const [term, setTerm] = useState({
    equipmentId: '', workerName: '', dueDate: '', accessories: '', stateOnDelivery: '', sigWh: '' as string | undefined, sigRec: '' as string | undefined,
  });
  const [returnFor, setReturnFor] = useState<CustodyTerm | null>(null);
  const [returnData, setReturnData] = useState({ stateOnReturn: '', divergenceNotes: '', status: 'devolvido' as CustodyTermStatus });

  const submitEq = () => {
    if (!eq.name.trim()) return;
    onProjectChange(addEquipment(project, eq));
    setEq({ name: '', patrimony: '', serial: '', category: '' });
  };

  const submitTerm = () => {
    const equipment = wh.equipments.find(e => e.id === term.equipmentId);
    if (!equipment || !term.workerName.trim()) return;
    onProjectChange(issueCustodyTerm(project, {
      equipmentId: equipment.id,
      equipmentName: equipment.name,
      equipmentPatrimony: equipment.patrimony,
      issuedAt: new Date().toISOString().slice(0, 10),
      dueDate: term.dueDate || undefined,
      workerName: term.workerName,
      accessories: term.accessories || undefined,
      stateOnDelivery: term.stateOnDelivery || undefined,
      signatureWarehouse: term.sigWh,
      signatureReceiver: term.sigRec,
    }));
    setShowTerm(false);
    setTerm({ equipmentId: '', workerName: '', dueDate: '', accessories: '', stateOnDelivery: '', sigWh: undefined, sigRec: undefined });
  };

  const submitReturn = () => {
    if (!returnFor) return;
    onProjectChange(returnCustodyTerm(project, returnFor.id, returnData));
    setReturnFor(null);
    setReturnData({ stateOnReturn: '', divergenceNotes: '', status: 'devolvido' });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* Equipamentos */}
      <div className="bg-card border border-border rounded-lg p-3 space-y-2">
        <div className="text-xs font-semibold">Cadastro de equipamentos</div>
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="Nome / modelo" className="h-8 text-xs" value={eq.name} onChange={e => setEq({ ...eq, name: e.target.value })} />
          <Input placeholder="Patrimônio" className="h-8 text-xs" value={eq.patrimony} onChange={e => setEq({ ...eq, patrimony: e.target.value })} />
          <Input placeholder="Nº de série" className="h-8 text-xs" value={eq.serial} onChange={e => setEq({ ...eq, serial: e.target.value })} />
          <Input placeholder="Categoria" className="h-8 text-xs" value={eq.category} onChange={e => setEq({ ...eq, category: e.target.value })} />
        </div>
        <Button size="sm" className="h-8 w-full" onClick={submitEq}><Plus className="w-3.5 h-3.5 mr-1" /> Cadastrar equipamento</Button>

        <table className="w-full text-xs mt-2">
          <thead className="bg-muted">
            <tr>
              <th className="p-1 text-left">Equipamento</th>
              <th className="p-1 text-left">Patrim.</th>
              <th className="p-1 text-left">Série</th>
              <th className="p-1 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {wh.equipments.map(e => (
              <tr key={e.id} className="border-t border-border">
                <td className="p-1">{e.name}</td>
                <td className="p-1 font-mono text-[10px]">{e.patrimony ?? '—'}</td>
                <td className="p-1 font-mono text-[10px]">{e.serial ?? '—'}</td>
                <td className="p-1"><button className="text-destructive" onClick={() => onProjectChange(removeEquipment(project, e.id))}><Trash2 className="w-3 h-3" /></button></td>
              </tr>
            ))}
            {wh.equipments.length === 0 && <tr><td colSpan={4} className="p-3 text-center text-muted-foreground italic">Nenhum equipamento.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Termos de Cautela */}
      <div className="bg-card border border-border rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold">Termos de cautela</div>
          <Button size="sm" className="h-7 text-[11px]" onClick={() => setShowTerm(s => !s)}><Plus className="w-3 h-3 mr-1" /> Novo termo</Button>
        </div>

        {showTerm && (
          <div className="border border-border rounded p-2 space-y-2 bg-muted/20">
            <select className="h-8 text-xs border border-border rounded px-2 bg-background w-full" value={term.equipmentId} onChange={e => setTerm({ ...term, equipmentId: e.target.value })}>
              <option value="">— escolher equipamento —</option>
              {wh.equipments.map(e => <option key={e.id} value={e.id}>{e.name} {e.patrimony ? `(${e.patrimony})` : ''}</option>)}
            </select>
            <Input placeholder="Funcionário/recebedor" className="h-8 text-xs" value={term.workerName} onChange={e => setTerm({ ...term, workerName: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <Input type="date" placeholder="Devolver até" className="h-8 text-xs" value={term.dueDate} onChange={e => setTerm({ ...term, dueDate: e.target.value })} />
              <Input placeholder="Estado na entrega" className="h-8 text-xs" value={term.stateOnDelivery} onChange={e => setTerm({ ...term, stateOnDelivery: e.target.value })} />
            </div>
            <Input placeholder="Acessórios" className="h-8 text-xs" value={term.accessories} onChange={e => setTerm({ ...term, accessories: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <SignaturePad label="Almoxarife" value={term.sigWh} onChange={v => setTerm({ ...term, sigWh: v })} height={80} />
              <SignaturePad label="Recebedor" value={term.sigRec} onChange={v => setTerm({ ...term, sigRec: v })} height={80} />
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowTerm(false)}>Cancelar</Button>
              <Button size="sm" onClick={submitTerm}>Emitir termo</Button>
            </div>
          </div>
        )}

        <table className="w-full text-xs">
          <thead className="bg-muted">
            <tr>
              <th className="p-1 text-left">Nº</th>
              <th className="p-1 text-left">Equip.</th>
              <th className="p-1 text-left">Recebedor</th>
              <th className="p-1 text-left">Status</th>
              <th className="p-1 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {wh.custodyTerms.slice().reverse().map(t => (
              <tr key={t.id} className="border-t border-border">
                <td className="p-1 font-mono text-[10px]">{t.number}</td>
                <td className="p-1">{t.equipmentName}</td>
                <td className="p-1">{t.workerName}</td>
                <td className="p-1">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                    t.status === 'em_uso' ? 'bg-warning/10 text-warning'
                    : t.status === 'devolvido' ? 'bg-success/10 text-success'
                    : 'bg-destructive/10 text-destructive'
                  }`}>{t.status}</span>
                </td>
                <td className="p-1 flex gap-1">
                  <button title="PDF" onClick={() => generateCustodyTermPdf(project, t)}><FileDown className="w-3 h-3 text-primary" /></button>
                  {t.status === 'em_uso' && (
                    <button title="Devolver" onClick={() => setReturnFor(t)}><Undo2 className="w-3 h-3 text-success" /></button>
                  )}
                </td>
              </tr>
            ))}
            {wh.custodyTerms.length === 0 && <tr><td colSpan={5} className="p-3 text-center text-muted-foreground italic">Nenhum termo emitido.</td></tr>}
          </tbody>
        </table>

        {returnFor && (
          <div className="border border-border rounded p-2 space-y-2 bg-muted/20">
            <div className="text-xs font-semibold">Devolução · {returnFor.number}</div>
            <Input placeholder="Estado na devolução" className="h-8 text-xs" value={returnData.stateOnReturn} onChange={e => setReturnData({ ...returnData, stateOnReturn: e.target.value })} />
            <select className="h-8 text-xs border border-border rounded px-2 bg-background w-full" value={returnData.status} onChange={e => setReturnData({ ...returnData, status: e.target.value as CustodyTermStatus })}>
              <option value="devolvido">Devolvido OK</option>
              <option value="divergencia">Devolvido com divergência</option>
              <option value="danificado">Danificado</option>
              <option value="perdido">Perdido / não devolvido</option>
            </select>
            {returnData.status !== 'devolvido' && (
              <Input placeholder="Notas da divergência" className="h-8 text-xs" value={returnData.divergenceNotes} onChange={e => setReturnData({ ...returnData, divergenceNotes: e.target.value })} />
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setReturnFor(null)}>Cancelar</Button>
              <Button size="sm" onClick={submitReturn}>Confirmar devolução</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
