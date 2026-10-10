import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { collapsedMeasurementGroups, rememberCollapsedMeasurementGroups, rememberMeasurement, selectedMeasurement } from './measurementSelection';
import type { MeasuredPeriod } from './measurementWorkspace';
const periods: MeasuredPeriod[] = [1,2,3].map(number=>({id:`m${number}`,number,startDate:'2026-01-01',endDate:'2026-01-30',status:'draft'}));
beforeEach(()=>localStorage.clear());
afterEach(()=>vi.restoreAllMocks());
describe('preferência da medição selecionada',()=>{
 it('usa identificador estável e isola usuário e obra',()=>{
  rememberMeasurement('u','obra-a','m2');
  expect(selectedMeasurement('u','obra-a',periods)).toBe('m2');
  expect(selectedMeasurement('outro','obra-a',periods)).toBe('m1');
  expect(selectedMeasurement('u','obra-b',periods)).toBe('m1');
 });
 it('ignora identificador inexistente e não seleciona período que não foi confirmado',()=>{
  rememberMeasurement('u','p','inexistente');
  expect(selectedMeasurement('u','p',periods)).toBe('m1');
  expect(selectedMeasurement('u','p',[])).toBe('');
 });
 it('falha de preferências não bloqueia acesso aos dados',()=>{
  vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('Storage bloqueado');});
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Quota');});
  expect(()=>rememberMeasurement('u','p','m2')).not.toThrow();
  expect(selectedMeasurement('u','p',periods)).toBe('m1');
 });
});

describe('capítulos minimizados na Medição', () => {
 it('isola a preferência por usuário e obra e ignora dados locais inválidos', () => {
  rememberCollapsedMeasurementGroups('u', 'obra-a', new Set(['capítulo', 'subcapítulo']));
  expect(collapsedMeasurementGroups('u', 'obra-a')).toEqual(new Set(['capítulo', 'subcapítulo']));
  expect(collapsedMeasurementGroups('outro', 'obra-a')).toEqual(new Set());
  expect(collapsedMeasurementGroups('u', 'obra-b')).toEqual(new Set());
  localStorage.setItem('obraplanner:measurement-collapsed:["u","obra-a"]', '{inválido');
  expect(collapsedMeasurementGroups('u', 'obra-a')).toEqual(new Set());
 });
 it('não bloqueia a Medição se o navegador não salvar preferências', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage bloqueado'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota'); });
  expect(collapsedMeasurementGroups('u', 'p')).toEqual(new Set());
  expect(() => rememberCollapsedMeasurementGroups('u', 'p', new Set(['capítulo']))).not.toThrow();
 });
});
