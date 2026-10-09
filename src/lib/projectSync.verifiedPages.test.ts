import { describe, expect, it } from 'vitest';
import { loadVerifiedRows } from './projectSync';

describe('carregamento contado e paginado', () => {
  const rows = Array.from({ length: 1200 }, (_, n) => ({ id: String(n).padStart(5, '0'), data: { actualQuantity: n } }));
  it('obtém os 1.200 registros, inclusive depois da primeira página', async () => {
    const cursors: (string | undefined)[] = [];
    const result = await loadVerifiedRows(async after => {
      cursors.push(after);
      const remaining = rows.filter(row => !after || row.id > after);
      return { data: remaining.slice(0,500), count: remaining.length, error:null };
    });
    expect(result.error).toBeNull(); expect(result.data).toEqual(rows);
    expect(cursors).toEqual([undefined,'00499','00999',undefined]);
  });
  it('recusa a resposta truncada de 1.000/1.200', async () => {
    const result = await loadVerifiedRows(async () => ({ data:rows.slice(0,1000), count:1200, error:null }));
    expect(result.data).toBeNull(); expect(result.error).toBeTruthy();
  });
  it('recusa ausência de contagem, duplicação e coleção que mudou entre páginas', async () => {
    expect((await loadVerifiedRows(async () => ({data:rows.slice(0,10),count:null,error:null}))).data).toBeNull();
    expect((await loadVerifiedRows(async () => ({data:[rows[0],rows[0]],count:2,error:null}))).data).toBeNull();
    expect((await loadVerifiedRows(async after => ({data:rows.filter(row => !after || row.id > after).slice(0,500),count:after ? 701 :1200,error:null}))).data).toBeNull();
  });
});
