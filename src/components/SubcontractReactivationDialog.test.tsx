import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SubcontractReactivationDialog } from './SubcontractReactivationDialog';
import type { Project, Subcontract } from '@/types/project';
const contract:Subcontract={id:'c',name:'Teste',contractorName:'Teste',status:'cancelled',contractedValue:50,contractDate:'2026-01-01',createdAt:'2026-01-01',payments:[{id:'p',date:'2026-01-01',createdAt:'2026-01-01',amount:20}],items:['a','b'].map(id=>({id,compositionId:id,item:id,description:`Atividade ${id}`,unit:'un',referenceLaborCost:50,allocationPercent:50,contractedAmount:25}))};
const project={id:'p',subcontracts:[contract,{...contract,id:'other',name:'Rascunho existente',status:'draft',items:[contract.items[1]]}]} as Project;
const catalog=[{id:'a',laborCost:50},{id:'b',laborCost:50}];
it('exige valor manual, motivo e cobertura dos pagamentos; mantém formulário após falha e só fecha com confirmação',async()=>{
 const onCommit=vi.fn().mockRejectedValueOnce(new Error('Outra sessão ocupou a atividade'));
 const onClose=vi.fn();render(<SubcontractReactivationDialog project={project} contract={contract} catalog={catalog} onCommit={onCommit} onClose={onClose} />);
 expect(screen.getByText(/Rascunho existente/)).toBeInTheDocument();expect(screen.getAllByRole('checkbox')).toHaveLength(1);expect(screen.getByRole('checkbox')).toBeChecked();
 const value=screen.getByLabelText('Novo valor total do contrato'), reason=screen.getByLabelText('Motivo da reativação'), confirm=screen.getByRole('button',{name:'Confirmar reativação'});
 expect(value).toHaveValue('');expect(confirm).toBeDisabled();
 fireEvent.change(value,{target:{value:'19'}});fireEvent.change(reason,{target:{value:'Retomar escopo'}});expect(confirm).toBeDisabled();
 fireEvent.change(value,{target:{value:'60'}});fireEvent.click(confirm);
 await screen.findByRole('alert');expect(onClose).not.toHaveBeenCalled();expect(value).toHaveValue('60');expect(reason).toHaveValue('Retomar escopo');
 let resolve!:()=>void;onCommit.mockImplementationOnce(()=>new Promise<void>(r=>{resolve=r;}));fireEvent.click(confirm);
 expect(screen.getByRole('button',{name:'Confirmando na nuvem…'})).toBeDisabled();expect(onClose).not.toHaveBeenCalled();resolve();await waitFor(()=>expect(onClose).toHaveBeenCalledOnce());
 const candidate=onCommit.mock.calls[1][0] as Project;expect(candidate.subcontracts![0].items.map(i=>i.id)).toEqual(['a']);expect(candidate.subcontracts![1]).toEqual(project.subcontracts![1]);expect(contract.status).toBe('cancelled');
});
it('não confirma nenhuma atividade livre ou vínculo sem catálogo',()=>{
 render(<SubcontractReactivationDialog project={project} contract={contract} catalog={[]} onCommit={vi.fn()} onClose={vi.fn()} />);
 expect(screen.getByText('Nenhuma atividade está livre para reativação.')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Confirmar reativação'})).toBeDisabled();expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});
