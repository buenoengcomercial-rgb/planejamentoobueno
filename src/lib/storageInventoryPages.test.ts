import { describe, expect, it } from 'vitest';
import { readCompletePages } from '../../supabase/functions/_shared/verifiedPages';
describe('inventário completo antes da limpeza', () => {
  it('preserva o vínculo 1001 mesmo quando o servidor reduz a página pedida', async () => {
    const all = Array.from({length:1001},(_,n)=>({id:String(n).padStart(5,'0'),storagePath:n===1000?'still-linked.pdf':undefined}));
    const rows = await readCompletePages(async (after,head) => {
      const tail=all.filter(r=>!after||r.id>after);
      return {data:head?null:tail.slice(0,100),count:tail.length,error:null};
    });
    expect(rows).toEqual(all);
    expect(rows.at(-1)?.storagePath).toBe('still-linked.pdf');
  });
  it('recusa contagem ausente, página vazia prematura e troca de coleção', async () => {
    await expect(readCompletePages(async()=>({data:[],count:null,error:null}))).rejects.toThrow();
    await expect(readCompletePages(async()=>({data:[],count:1,error:null}))).rejects.toThrow();
    await expect(readCompletePages(async(_a,head)=>({data:[{id:'a'}],count:head?2:1,error:null}))).rejects.toThrow();
  });
});
