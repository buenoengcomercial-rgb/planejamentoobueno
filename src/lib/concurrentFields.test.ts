import { expect, it } from 'vitest';
import { mergeConcurrentFields } from './concurrentFields';

it('preserva reordenação local quando a outra pessoa altera um campo', () => {
  const base = [{ id: 'a', q: 1 }, { id: 'b', q: 2 }];
  expect(mergeConcurrentFields(base, [...base].reverse(), [{ id: 'a', q: 3 }, base[1]]))
    .toEqual({ value: [base[1], { id: 'a', q: 3 }], conflicts: [] });
});

it('sinaliza reordenações concorrentes incompatíveis', () => {
  const base = ['a', 'b', 'c'].map(id => ({ id }));
  const remote = [base[0], base[2], base[1]];
  expect(mergeConcurrentFields(base, [base[1], base[0], base[2]], remote))
    .toEqual({ value: remote, conflicts: ['/$order'] });
});

it('combina campos e registros independentes sem modificar as entradas', () => {
  const base={rows:[{id:'a',quantity:1,note:'old'},{id:'b',quantity:2}]};
  const local={rows:[{id:'a',quantity:3,note:'old'},{id:'b',quantity:2}]};
  const remote={rows:[{id:'a',quantity:1,note:'remote'},{id:'b',quantity:4}]};
  expect(mergeConcurrentFields(base,local,remote)).toEqual({value:{rows:[{id:'a',quantity:3,note:'remote'},{id:'b',quantity:4}]},conflicts:[]});
  expect(local.rows[0].note).toBe('old');
});
it('preserva primeiro valor e identifica somente o campo conflitante', () => {
  expect(mergeConcurrentFields({q:1,note:''},{q:2,note:'local'},{q:3,note:''})).toEqual({value:{q:3,note:'local'},conflicts:['/q']});
});
it('recusa ressuscitar registro removido e não compara ordem de propriedades JSON', () => {
  expect(mergeConcurrentFields({rows:[{id:'a',q:1}]},{rows:[{id:'a',q:2}]},{rows:[]})).toEqual({value:{rows:[]},conflicts:['/rows/a']});
  expect(mergeConcurrentFields({q:1,note:''},{note:'',q:1},{note:'remote',q:2}).conflicts).toEqual([]);
});
it('trata coordenadas sem identificador como um campo indivisível', () => {
  expect(mergeConcurrentFields([1,2],[3,2],[1,4])).toEqual({value:[1,4],conflicts:['/']});
});


it('mescla campos de registro sem disputar carimbo e autor gerados pela edição', () => {
  const base={id:'eq',name:'A',notes:'',updatedAt:'t0',updatedBy:{userId:'original'}};
  const local={...base,name:'B',updatedAt:'t2',updatedBy:{userId:'second'}};
  const remote={...base,notes:'N',updatedAt:'t1',updatedBy:{userId:'first'}};
  expect(mergeConcurrentFields(base,local,remote)).toEqual({value:{...local,notes:'N'},conflicts:[]});
  expect(mergeConcurrentFields(base,{...local,notes:'Collision'},remote).conflicts).toEqual(['/notes']);
  expect(mergeConcurrentFields({updatedAt:'a'},{updatedAt:'b'},{updatedAt:'c'}).conflicts).toEqual(['/updatedAt']);
});

it('concilia datas posteriores do cronograma do aditivo sem restaurar planos removidos', () => {
  const base = { additives: [{ id: 'aditivo', data: { scheduleDraft: {
    updatedAt: 't0', contractedTaskPlans: [
      { taskId: 'removido', startDate: '2026-09-01' },
      { taskId: 'editado', startDate: '2026-09-01' },
      { taskId: 'confirmado', startDate: '2026-09-01' },
    ],
  } } }] };
  const local = structuredClone(base);
  local.additives[0].data.scheduleDraft.updatedAt = 't2';
  local.additives[0].data.scheduleDraft.contractedTaskPlans[1].startDate = '2026-09-29';
  const remote = structuredClone(base);
  remote.additives[0].data.scheduleDraft.updatedAt = 't1';
  remote.additives[0].data.scheduleDraft.contractedTaskPlans = [
    { taskId: 'editado', startDate: '2026-09-01' },
    { taskId: 'confirmado', startDate: '2026-10-01' },
  ];

  expect(mergeConcurrentFields(base, local, remote)).toEqual({
    value: { additives: [{ id: 'aditivo', data: { scheduleDraft: {
      updatedAt: 't2', contractedTaskPlans: [
        { taskId: 'editado', startDate: '2026-09-29' },
        { taskId: 'confirmado', startDate: '2026-10-01' },
      ],
    } } }] },
    conflicts: [],
  });
  const competing = structuredClone(remote);
  competing.additives[0].data.scheduleDraft.contractedTaskPlans[0].startDate = '2026-10-02';
  expect(mergeConcurrentFields(base, local, competing).conflicts)
    .toEqual(['/additives/aditivo/data/scheduleDraft/contractedTaskPlans/editado/startDate']);
});
