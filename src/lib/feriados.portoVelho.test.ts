import { expect, it } from 'vitest';
import { getFeriadosAno, isDiaUtil } from './feriados';

it('desconta Consciência Negra e distingue feriados estaduais e municipais de Porto Velho', () => {
  expect(isDiaUtil(new Date(2026, 10, 20), 'RO', 'Porto Velho', false)).toBe(false);
  expect(getFeriadosAno(2027, 'RO', 'Porto Velho')).toEqual(expect.arrayContaining([
    expect.objectContaining({ data: '2027-01-04', tipo: 'estadual' }),
    expect.objectContaining({ data: '2027-01-24', tipo: 'municipal' }),
    expect.objectContaining({ data: '2027-05-24', tipo: 'municipal' }),
  ]));
});
