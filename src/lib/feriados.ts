// Brazilian holidays library with Easter calculation (Butcher's algorithm)
import type { WorkdayException } from '@/types/project';

// Easter calculation using Butcher's algorithm
function calcularPascoa(ano: number): Date {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, month - 1, day);
}

function addDaysToDate(date: Date, days: number): Date {
  const r = new Date(date);
  r.setDate(r.getDate() + days);
  return r;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Fixed national holidays (month is 0-indexed)
const FERIADOS_NACIONAIS_FIXOS: { mes: number; dia: number; nome: string }[] = [
  { mes: 0, dia: 1, nome: 'Confraternização Universal' },
  { mes: 3, dia: 21, nome: 'Tiradentes' },
  { mes: 4, dia: 1, nome: 'Dia do Trabalho' },
  { mes: 8, dia: 7, nome: 'Independência do Brasil' },
  { mes: 9, dia: 12, nome: 'Nossa Senhora Aparecida' },
  { mes: 10, dia: 2, nome: 'Finados' },
  { mes: 10, dia: 15, nome: 'Proclamação da República' },
  { mes: 11, dia: 25, nome: 'Natal' },
];

// State holidays by UF
const FERIADOS_ESTADUAIS: Record<string, { mes: number; dia: number; nome: string }[]> = {
  AC: [{ mes: 0, dia: 23, nome: 'Dia do Evangélico' }, { mes: 5, dia: 15, nome: 'Aniversário do Acre' }, { mes: 8, dia: 5, nome: 'Dia da Amazônia' }, { mes: 10, dia: 17, nome: 'Tratado de Petrópolis' }],
  AL: [{ mes: 5, dia: 24, nome: 'São João' }, { mes: 5, dia: 29, nome: 'São Pedro' }, { mes: 8, dia: 16, nome: 'Emancipação Política' }, { mes: 10, dia: 20, nome: 'Consciência Negra' }],
  AP: [{ mes: 2, dia: 19, nome: 'Dia de São José' }, { mes: 8, dia: 13, nome: 'Criação do Território' }, { mes: 10, dia: 20, nome: 'Consciência Negra' }],
  AM: [{ mes: 8, dia: 5, nome: 'Elevação do Amazonas' }, { mes: 10, dia: 20, nome: 'Consciência Negra' }],
  BA: [{ mes: 6, dia: 2, nome: 'Independência da Bahia' }],
  CE: [{ mes: 2, dia: 19, nome: 'Dia de São José' }, { mes: 2, dia: 25, nome: 'Data Magna do Ceará' }],
  DF: [{ mes: 3, dia: 21, nome: 'Fundação de Brasília' }, { mes: 10, dia: 30, nome: 'Dia do Evangélico' }],
  ES: [{ mes: 9, dia: 28, nome: 'Dia do Servidor Público' }],
  GO: [{ mes: 9, dia: 28, nome: 'Dia do Servidor Público' }],
  MA: [{ mes: 6, dia: 28, nome: 'Adesão do Maranhão' }],
  MT: [{ mes: 10, dia: 20, nome: 'Consciência Negra' }],
  MS: [{ mes: 9, dia: 11, nome: 'Criação do Estado' }],
  MG: [{ mes: 3, dia: 21, nome: 'Data Magna de Minas' }],
  PA: [{ mes: 7, dia: 15, nome: 'Adesão do Grão-Pará' }],
  PB: [{ mes: 7, dia: 5, nome: 'Fundação do Estado' }],
  PR: [{ mes: 11, dia: 19, nome: 'Emancipação Política' }],
  PE: [{ mes: 2, dia: 6, nome: 'Revolução Pernambucana' }],
  PI: [{ mes: 9, dia: 19, nome: 'Dia do Piauí' }],
  RJ: [{ mes: 3, dia: 23, nome: 'Dia de São Jorge' }, { mes: 10, dia: 20, nome: 'Consciência Negra' }],
  RN: [{ mes: 9, dia: 3, nome: 'Mártires de Cunhaú e Uruaçu' }],
  RS: [{ mes: 8, dia: 20, nome: 'Revolução Farroupilha' }],
  RO: [{ mes: 0, dia: 4, nome: 'Criação do Estado' }, { mes: 5, dia: 18, nome: 'Dia do Evangélico' }],
  RR: [{ mes: 9, dia: 5, nome: 'Criação de Roraima' }],
  SC: [{ mes: 7, dia: 11, nome: 'Criação da Capitania' }],
  SP: [{ mes: 6, dia: 9, nome: 'Revolução Constitucionalista' }],
  SE: [{ mes: 6, dia: 8, nome: 'Emancipação Política' }],
  TO: [{ mes: 9, dia: 5, nome: 'Criação do Estado' }],
};

// Municipal holidays (main capitals)
const FERIADOS_MUNICIPAIS: Record<string, { mes: number; dia: number; nome: string }[]> = {
  'São Paulo': [{ mes: 0, dia: 25, nome: 'Aniversário de São Paulo' }],
  'Rio de Janeiro': [{ mes: 0, dia: 20, nome: 'Dia de São Sebastião' }, { mes: 3, dia: 23, nome: 'Dia de São Jorge' }],
  'Belo Horizonte': [{ mes: 11, dia: 12, nome: 'Aniversário de BH' }],
  'Salvador': [{ mes: 1, dia: 2, nome: 'Dia de Iemanjá' }],
  'Curitiba': [{ mes: 2, dia: 29, nome: 'Aniversário de Curitiba' }],
  'Porto Alegre': [{ mes: 1, dia: 2, nome: 'Dia de Navegantes' }],
  'Recife': [{ mes: 2, dia: 12, nome: 'Aniversário de Recife' }],
  'Fortaleza': [{ mes: 3, dia: 13, nome: 'Aniversário de Fortaleza' }],
  'Manaus': [{ mes: 9, dia: 24, nome: 'Aniversário de Manaus' }],
  'Belém': [{ mes: 0, dia: 12, nome: 'Aniversário de Belém' }],
  'Goiânia': [{ mes: 9, dia: 24, nome: 'Aniversário de Goiânia' }],
  'Brasília': [{ mes: 3, dia: 21, nome: 'Aniversário de Brasília' }],
  'Porto Velho': [{ mes: 0, dia: 4, nome: 'Aniversário de Porto Velho' }, { mes: 9, dia: 2, nome: 'Dia do Evangélico' }],
  'Vitória': [{ mes: 8, dia: 8, nome: 'Aniversário de Vitória' }],
  'Natal': [{ mes: 11, dia: 25, nome: 'Aniversário de Natal' }],
  'Campo Grande': [{ mes: 7, dia: 26, nome: 'Aniversário de Campo Grande' }],
  'Cuiabá': [{ mes: 3, dia: 8, nome: 'Aniversário de Cuiabá' }],
  'João Pessoa': [{ mes: 7, dia: 5, nome: 'Aniversário de João Pessoa' }],
  'Teresina': [{ mes: 7, dia: 16, nome: 'Aniversário de Teresina' }],
  'São Luís': [{ mes: 8, dia: 8, nome: 'Aniversário de São Luís' }],
  'Maceió': [{ mes: 11, dia: 5, nome: 'Aniversário de Maceió' }],
  'Aracaju': [{ mes: 2, dia: 17, nome: 'Aniversário de Aracaju' }],
  'Florianópolis': [{ mes: 2, dia: 23, nome: 'Aniversário de Florianópolis' }],
  'Macapá': [{ mes: 1, dia: 4, nome: 'Aniversário de Macapá' }],
  'Boa Vista': [{ mes: 5, dia: 9, nome: 'Aniversário de Boa Vista' }],
  'Palmas': [{ mes: 4, dia: 20, nome: 'Aniversário de Palmas' }],
  'Rio Branco': [{ mes: 11, dia: 28, nome: 'Aniversário de Rio Branco' }],
};

export interface FeriadoInfo {
  data: string; // YYYY-MM-DD
  nome: string;
  tipo: 'nacional' | 'estadual' | 'municipal';
}

export function getFeriadosAno(ano: number, uf: string, municipio: string): FeriadoInfo[] {
  const feriados: FeriadoInfo[] = [];

  // National fixed
  FERIADOS_NACIONAIS_FIXOS.forEach(f => {
    feriados.push({ data: dateKey(new Date(ano, f.mes, f.dia)), nome: f.nome, tipo: 'nacional' });
  });

  // National mobile (Easter-based)
  const pascoa = calcularPascoa(ano);
  const carnaval = addDaysToDate(pascoa, -47);
  const sextaSanta = addDaysToDate(pascoa, -2);
  const corpusChristi = addDaysToDate(pascoa, 60);

  feriados.push({ data: dateKey(carnaval), nome: 'Carnaval', tipo: 'nacional' });
  feriados.push({ data: dateKey(addDaysToDate(carnaval, 1)), nome: 'Carnaval', tipo: 'nacional' });
  feriados.push({ data: dateKey(sextaSanta), nome: 'Sexta-feira Santa', tipo: 'nacional' });
  feriados.push({ data: dateKey(corpusChristi), nome: 'Corpus Christi', tipo: 'nacional' });

  // State
  const estaduais = FERIADOS_ESTADUAIS[uf] || [];
  estaduais.forEach(f => {
    feriados.push({ data: dateKey(new Date(ano, f.mes, f.dia)), nome: f.nome, tipo: 'estadual' });
  });

  // Municipal
  const municipais = FERIADOS_MUNICIPAIS[municipio] || [];
  municipais.forEach(f => {
    feriados.push({ data: dateKey(new Date(ano, f.mes, f.dia)), nome: f.nome, tipo: 'municipal' });
  });

  return feriados;
}

export function getFeriadosMap(startDate: Date, endDate: Date, uf: string, municipio: string): Map<string, FeriadoInfo> {
  const map = new Map<string, FeriadoInfo>();
  const startYear = startDate.getFullYear();
  const endYear = endDate.getFullYear();
  for (let y = startYear; y <= endYear; y++) {
    const feriados = getFeriadosAno(y, uf, municipio);
    feriados.forEach(f => {
      if (!map.has(f.data)) map.set(f.data, f);
    });
  }
  return map;
}

export function isDiaUtil(data: Date, uf: string, municipio: string, trabalhaSabado: boolean): boolean {
  const dow = data.getDay();
  if (dow === 0) return false; // Sunday
  if (dow === 6 && !trabalhaSabado) return false; // Saturday
  const key = dateKey(data);
  const feriados = getFeriadosAno(data.getFullYear(), uf, municipio);
  return !feriados.some(f => f.data === key);
}

export function calcularDiasUteis(
  inicio: Date,
  fim: Date,
  uf: string,
  municipio: string,
  trabalhaSabado: boolean,
  jornadaDiaria: number = 8,
  exceptions: WorkdayException[] = [],
): { dias: number; horas: number } {
  const feriadoMap = getFeriadosMap(inicio, fim, uf, municipio);
  let dias = 0;
  const current = new Date(inicio);
  current.setHours(0, 0, 0, 0);
  const end = new Date(fim);
  end.setHours(0, 0, 0, 0);

  while (current <= end) {
    const dow = current.getDay();
    const key = dateKey(current);
    const isFeriado = feriadoMap.has(key);
    const isException = exceptions.some(item => item.date === key);

    if (isException) {
      dias += 1;
    } else if (dow === 0 || isFeriado) {
      // skip
    } else if (dow === 6) {
      if (trabalhaSabado) dias += 0.5;
    } else {
      dias += 1;
    }
    current.setDate(current.getDate() + 1);
  }

  const horasSabado = trabalhaSabado ? jornadaDiaria / 2 : 0;
  // Recalculate hours properly
  let horas = 0;
  const cur2 = new Date(inicio);
  cur2.setHours(0, 0, 0, 0);
  while (cur2 <= end) {
    const dow = cur2.getDay();
    const key = dateKey(cur2);
    const isFeriado = feriadoMap.has(key);
    const isException = exceptions.some(item => item.date === key);
    if (isException) {
      horas += jornadaDiaria;
    } else if (dow === 0 || isFeriado) {
      // skip
    } else if (dow === 6) {
      if (trabalhaSabado) horas += jornadaDiaria / 2;
    } else {
      horas += jornadaDiaria;
    }
    cur2.setDate(cur2.getDate() + 1);
  }

  return { dias, horas };
}

// List of Brazilian states
export const ESTADOS_BRASIL = [
  { uf: 'AC', nome: 'Acre' }, { uf: 'AL', nome: 'Alagoas' }, { uf: 'AP', nome: 'Amapá' },
  { uf: 'AM', nome: 'Amazonas' }, { uf: 'BA', nome: 'Bahia' }, { uf: 'CE', nome: 'Ceará' },
  { uf: 'DF', nome: 'Distrito Federal' }, { uf: 'ES', nome: 'Espírito Santo' }, { uf: 'GO', nome: 'Goiás' },
  { uf: 'MA', nome: 'Maranhão' }, { uf: 'MT', nome: 'Mato Grosso' }, { uf: 'MS', nome: 'Mato Grosso do Sul' },
  { uf: 'MG', nome: 'Minas Gerais' }, { uf: 'PA', nome: 'Pará' }, { uf: 'PB', nome: 'Paraíba' },
  { uf: 'PR', nome: 'Paraná' }, { uf: 'PE', nome: 'Pernambuco' }, { uf: 'PI', nome: 'Piauí' },
  { uf: 'RJ', nome: 'Rio de Janeiro' }, { uf: 'RN', nome: 'Rio Grande do Norte' },
  { uf: 'RS', nome: 'Rio Grande do Sul' }, { uf: 'RO', nome: 'Rondônia' }, { uf: 'RR', nome: 'Roraima' },
  { uf: 'SC', nome: 'Santa Catarina' }, { uf: 'SP', nome: 'São Paulo' }, { uf: 'SE', nome: 'Sergipe' },
  { uf: 'TO', nome: 'Tocantins' },
];

// Capitals by state
export const CAPITAIS: Record<string, string> = {
  AC: 'Rio Branco', AL: 'Maceió', AP: 'Macapá', AM: 'Manaus', BA: 'Salvador',
  CE: 'Fortaleza', DF: 'Brasília', ES: 'Vitória', GO: 'Goiânia', MA: 'São Luís',
  MT: 'Cuiabá', MS: 'Campo Grande', MG: 'Belo Horizonte', PA: 'Belém', PB: 'João Pessoa',
  PR: 'Curitiba', PE: 'Recife', PI: 'Teresina', RJ: 'Rio de Janeiro', RN: 'Natal',
  RS: 'Porto Alegre', RO: 'Porto Velho', RR: 'Boa Vista', SC: 'Florianópolis',
  SP: 'São Paulo', SE: 'Aracaju', TO: 'Palmas',
};

// Get municipalities for a given state (capitals + known municipalities with holidays)
export function getMunicipios(uf: string): string[] {
  const capital = CAPITAIS[uf];
  const allMunicipios = Object.keys(FERIADOS_MUNICIPAIS);
  const result = new Set<string>();
  if (capital) result.add(capital);
  // Add municipalities that match this state's capital
  allMunicipios.forEach(m => {
    if (m === capital) result.add(m);
  });
  return Array.from(result).sort();
}
