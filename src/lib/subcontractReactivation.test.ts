import { describe, expect, it } from 'vitest';
import { lifecycleHistory, reactivateSubcontract, reactivationAvailability } from './subcontractReactivation';
import type { Subcontract } from '@/types/project';

const cancelled = (): Subcontract => ({ id: 'c', name: 'Cancelado', contractorName: 'Empresa', contractDate: '2026-01-01', createdAt: '2026-01-01',
  status: 'cancelled', contractedValue: 100, cancelledAt: '2026-02-01', cancellationReason: 'Pausa',
  items: ['a','b'].map((id, i) => ({ id: `allocation-${id}`, compositionId: id, item: id, description: id, unit: 'm', referenceLaborCost: 50,
    allocationPercent: 50, contractedAmount: 50, contractedQuantity: 10, simulatedExecutedQuantity: i })),
  payments: [{ id: 'p', date: '2026-01-02', amount: 20, createdAt: '2026-01-02', notes: 'Anterior' }],
});
const catalog = [{ id: 'a', laborCost: 50 }, { id: 'b', laborCost: 50 }];
describe('reativação de contratos', () => {
  it('exclui atividades ocupadas por contratado ou rascunho e ignora cancelados', () => {
    for (const status of ['contracted','draft'] as const) {
      const other = { ...cancelled(), id: 'other', status, items: [cancelled().items[1]] };
      expect(reactivationAvailability(cancelled(), [other], catalog).map(x => x.free)).toEqual([true, false]);
    }
    expect(reactivationAvailability(cancelled(), [{ ...cancelled(), id: 'other' }], catalog).every(x => x.free)).toBe(true);
  });
  it('preserva identidade, pagamentos congelados, simulação e escopo anterior na reativação parcial', () => {
    const old = cancelled(); const before = structuredClone(old);
    const next = reactivateSubcontract(old, [], catalog, ['allocation-a'], 70, 'Retomada parcial', '2026-03-01', 'owner');
    expect(next.id).toBe(old.id); expect(next.items[0]).toMatchObject({id: 'allocation-a', contractedAmount: 70, contractedQuantity: 10});
    expect(next.payments[0]).toMatchObject({ ...old.payments[0], allocations: [{allocationId:'allocation-a',amount:10},{allocationId:'allocation-b',amount:10}] });
    expect(next.amendments?.[0].previousItems).toEqual(old.items);
    expect(next.lifecycleEvents?.map(e=>e.action)).toEqual(['cancelled','reactivated']);
    expect(old).toEqual(before);
  });
  it('bloqueia valor inválido, saldo insuficiente, vínculo ausente/ambíguo e seleção vazia', () => {
    for (const total of [0,-1,NaN,Infinity,19,20.001]) expect(()=>reactivateSubcontract(cancelled(),[],catalog,['allocation-a'],total,'Motivo','now')).toThrow();
    for (const rows of [[],[catalog[0],catalog[0]]]) expect(()=>reactivateSubcontract(cancelled(),[],rows,['allocation-a'],50,'Motivo','now')).toThrow();
    expect(()=>reactivateSubcontract(cancelled(),[],catalog,[],50,'Motivo','now')).toThrow();
    expect(()=>reactivateSubcontract(cancelled(),[],catalog,['allocation-a'],50,' ','now')).toThrow();
  });
  it('preserva históricos em ciclos sucessivos e não duplica cancelamento legado', () => {
    const first = reactivateSubcontract(cancelled(), [], catalog, ['allocation-a','allocation-b'], 100, 'Retomar', '2026-03-01');
    const secondCancel = {...first, status:'cancelled' as const, cancelledAt:'2026-04-01', cancellationReason:'Nova pausa'};
    const next = reactivateSubcontract(secondCancel, [], catalog, ['allocation-a'], 60, 'Retomar outra vez', '2026-05-01');
    expect(next.lifecycleEvents?.map(e=>e.action)).toEqual(['cancelled','reactivated','cancelled','reactivated']);
    expect(lifecycleHistory(next)).toHaveLength(4);
  });
});

it('preserva comprovantes, estornos e rateios já congelados em reativação integral',()=>{
 const old=cancelled();old.payments[0].allocations=[{allocationId:'allocation-a',amount:4},{allocationId:'allocation-b',amount:16}];
 old.payments[0].attachments=[{id:'receipt',name:'Comprovante',url:'private/receipt'}] as unknown as NonNullable<Subcontract['payments'][number]['attachments']>;
 old.payments.push({...old.payments[0],id:'reversed',amount:100,reversedAt:'2026-02-02',reversedBy:'owner',reversalReason:'Estorno'});
 const next=reactivateSubcontract(old,[],catalog,['allocation-a','allocation-b'],20,'Revisão','2026-03-01','owner');
 expect(next.payments).toEqual(old.payments);expect(next.items.map(i=>i.contractedAmount)).toEqual([10,10]);expect(next.items.map(i=>i.simulatedExecutedQuantity)).toEqual([0,1]);
});
it('não considera livre um vínculo textual legado ocupado ou a atividade tomada após abrir a revisão',()=>{
 const other={...cancelled(),id:'other',status:'draft' as const,items:[{...cancelled().items[0],compositionId:'legacy'}]};
 expect(reactivationAvailability(cancelled(),[other],catalog)[0].free).toBe(false);
 expect(()=>reactivateSubcontract(cancelled(),[other],catalog,['allocation-a'],50,'Retomar','2026-03-01')).toThrow('livres');
});
