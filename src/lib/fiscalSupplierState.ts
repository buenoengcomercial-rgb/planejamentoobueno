const STATE_BY_CUF: Record<string, string> = {
  '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
  '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA',
  '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP',
  '41': 'PR', '42': 'SC', '43': 'RS',
  '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
};

const VALID_STATES = new Set(Object.values(STATE_BY_CUF));

const STATE_BY_NAME: Record<string, string> = {
  'ACRE': 'AC', 'ALAGOAS': 'AL', 'AMAPA': 'AP', 'AMAZONAS': 'AM', 'BAHIA': 'BA', 'CEARA': 'CE',
  'DISTRITO FEDERAL': 'DF', 'ESPIRITO SANTO': 'ES', 'GOIAS': 'GO', 'MARANHAO': 'MA',
  'MATO GROSSO DO SUL': 'MS', 'MATO GROSSO': 'MT', 'MINAS GERAIS': 'MG', 'PARA': 'PA',
  'PARAIBA': 'PB', 'PARANA': 'PR', 'PERNAMBUCO': 'PE', 'PIAUI': 'PI', 'RIO DE JANEIRO': 'RJ',
  'RIO GRANDE DO NORTE': 'RN', 'RIO GRANDE DO SUL': 'RS', 'RONDONIA': 'RO', 'RORAIMA': 'RR',
  'SANTA CATARINA': 'SC', 'SAO PAULO': 'SP', 'SERGIPE': 'SE', 'TOCANTINS': 'TO',
};

function normalizeText(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ');
}

function stateFromAccessKey(text: string) {
  const candidates = text.match(/(?<!\d)(?:\d[\s.]*){44}(?!\d)/g) ?? [];
  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, '');
    const state = STATE_BY_CUF[digits.slice(0, 2)];
    if (digits.length === 44 && state) return state;
  }
  return undefined;
}

function supplierContext(text: string, supplierName?: string, supplierCnpj?: string) {
  const normalized = normalizeText(text);
  const cnpjDigits = (supplierCnpj ?? '').replace(/\D/g, '');
  if (cnpjDigits.length === 14) {
    const flexibleCnpj = new RegExp(cnpjDigits.split('').join('\\D*'));
    const match = flexibleCnpj.exec(normalized);
    if (match) return normalized.slice(Math.max(0, match.index - 900), match.index + match[0].length);
  }

  const name = normalizeText(supplierName ?? '').trim();
  if (name.length >= 5) {
    const index = normalized.indexOf(name);
    if (index >= 0) return normalized.slice(index, index + 1200);
  }
  return normalized.slice(0, 1400);
}

function stateFromSupplierAddress(text: string, supplierName?: string, supplierCnpj?: string) {
  const context = supplierContext(text, supplierName, supplierCnpj);
  const labelled = [...context.matchAll(/(?:\bUF\b|\/)[\s:.-]*([A-Z]{2})\b/g)]
    .map(match => match[1])
    .filter(state => VALID_STATES.has(state));
  if (labelled.length) return labelled[0];

  const stateName = Object.keys(STATE_BY_NAME)
    .sort((left, right) => right.length - left.length)
    .find(name => name.includes(' ')
      ? context.includes(name)
      : new RegExp(`\\b(?:ESTADO(?:\\s+DE)?|UF)\\s*[:.-]?\\s*${name}\\b`).test(context));
  if (stateName) return STATE_BY_NAME[stateName];

  const standalone = [...context.matchAll(/\b[A-Z]{2}\b/g)]
    .map(match => match[0])
    .filter(state => VALID_STATES.has(state));
  return standalone.length ? standalone[0] : undefined;
}

export function normalizeBrazilianState(value?: string | null) {
  const normalized = normalizeText(value ?? '').trim();
  if (VALID_STATES.has(normalized)) return normalized;
  return STATE_BY_NAME[normalized];
}

/** Uses the NF-e cUF first, then the supplier address. It never uses the work/recipient UF as a fallback. */
export function inferSupplierState(text?: string, supplierName?: string, supplierCnpj?: string) {
  if (!text?.trim()) return undefined;
  return stateFromAccessKey(text) ?? stateFromSupplierAddress(text, supplierName, supplierCnpj);
}
