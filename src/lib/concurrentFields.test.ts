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
