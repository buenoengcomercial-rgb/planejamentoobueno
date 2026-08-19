const STATE_BY_CUF: Record<string, string> = {
  "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO",
  "21": "MA", "22": "PI", "23": "CE", "24": "RN", "25": "PB", "26": "PE", "27": "AL", "28": "SE", "29": "BA",
  "31": "MG", "32": "ES", "33": "RJ", "35": "SP", "41": "PR", "42": "SC", "43": "RS",
  "50": "MS", "51": "MT", "52": "GO", "53": "DF",
};

const VALID_STATES = new Set(Object.values(STATE_BY_CUF));

const STATE_BY_NAME: Record<string, string> = {
  "ACRE": "AC", "ALAGOAS": "AL", "AMAPA": "AP", "AMAZONAS": "AM", "BAHIA": "BA", "CEARA": "CE",
  "DISTRITO FEDERAL": "DF", "ESPIRITO SANTO": "ES", "GOIAS": "GO", "MARANHAO": "MA",
  "MATO GROSSO DO SUL": "MS", "MATO GROSSO": "MT", "MINAS GERAIS": "MG", "PARA": "PA",
  "PARAIBA": "PB", "PARANA": "PR", "PERNAMBUCO": "PE", "PIAUI": "PI", "RIO DE JANEIRO": "RJ",
  "RIO GRANDE DO NORTE": "RN", "RIO GRANDE DO SUL": "RS", "RONDONIA": "RO", "RORAIMA": "RR",
  "SANTA CATARINA": "SC", "SAO PAULO": "SP", "SERGIPE": "SE", "TOCANTINS": "TO",
};

function digits(value?: string | null) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeText(value?: string | null) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}

function accessKeyCheckDigit(key: string) {
  let weight = 2;
  let sum = 0;
  for (let index = 42; index >= 0; index -= 1) {
    sum += Number(key[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return remainder === 0 || remainder === 1 ? 0 : 11 - remainder;
}

export function isValidFiscalAccessKey(value?: string | null) {
  const key = digits(value);
  return key.length === 44
    && !!STATE_BY_CUF[key.slice(0, 2)]
    && accessKeyCheckDigit(key) === Number(key[43]);
}

function accessKeyCandidates(value?: string | null) {
  const source = String(value ?? "");
  const separated: string[] = [...(source.match(/(?<!\d)(?:\d[\s./-]*){44}(?!\d)/g) ?? [])];
  if (/^\d{44}$/.test(source.trim())) separated.unshift(source.trim());
  return separated.map(digits);
}

export function findValidFiscalAccessKey(...sources: Array<string | null | undefined>) {
  for (const source of sources) {
    for (const candidate of accessKeyCandidates(source)) {
      if (isValidFiscalAccessKey(candidate)) return candidate;
    }
  }
  return undefined;
}

function isValidCnpj(value?: string | null) {
  const valueDigits = digits(value);
  if (valueDigits.length !== 14 || /^(\d)\1{13}$/.test(valueDigits)) return false;
  const calculate = (length: number) => {
    let weight = length - 7;
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(valueDigits[index]) * weight--;
      if (weight < 2) weight = 9;
    }
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return calculate(12) === Number(valueDigits[12]) && calculate(13) === Number(valueDigits[13]);
}

function formatCnpj(value?: string | null) {
  const valueDigits = digits(value);
  if (!isValidCnpj(valueDigits)) return undefined;
  return valueDigits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function inferSupplierCnpjFromHeader(headerText?: string | null) {
  const issuer = issuerSection(headerText);
  const labels = [...issuer.matchAll(/CNPJ\s*\/?\s*CPF/gi)];
  for (const label of labels) {
    const start = (label.index ?? 0) + label[0].length;
    const candidates = issuer.slice(start, start + 120).match(/(?<!\d)(?:\d[\s./-]*){14}(?!\d)/g) ?? [];
    for (const candidate of candidates) {
      const formatted = formatCnpj(candidate);
      if (formatted) return formatted;
    }
  }
  return undefined;
}

function resolveHeaderCnpj(headerText?: string | null, aiCnpj?: string | null) {
  const inferred = inferSupplierCnpjFromHeader(headerText);
  if (inferred) return inferred;
  const formattedAi = formatCnpj(aiCnpj);
  if (!formattedAi) return undefined;
  const issuer = issuerSection(headerText);
  if (issuer.trim() && !digits(issuer).includes(digits(formattedAi))) return undefined;
  return formattedAi;
}

function issuerSection(value?: string | null) {
  const normalized = normalizeText(value);
  return normalized.split(/\bDESTINATARIO\s*\/?\s*REMETENTE\b/, 1)[0];
}

function supplierContext(text: string, supplierName?: string | null, supplierCnpj?: string | null) {
  const issuer = issuerSection(text);
  const cnpj = digits(supplierCnpj);
  if (cnpj.length === 14) {
    const match = new RegExp(cnpj.split("").join("\\D*")).exec(issuer);
    if (match) return issuer.slice(Math.max(0, match.index - 900), match.index + match[0].length);
  }
  const name = normalizeText(supplierName);
  const index = name.length >= 5 ? issuer.indexOf(name) : -1;
  return index >= 0 ? issuer.slice(index, index + 1200) : issuer.slice(0, 1400);
}

export function inferSupplierStateFromHeader(text?: string | null, supplierName?: string | null, supplierCnpj?: string | null) {
  const context = supplierContext(String(text ?? ""), supplierName, supplierCnpj);
  const labelled = [...context.matchAll(/(?:\bUF\b|\/)[\s:.-]*([A-Z]{2})\b/g)]
    .map((match) => match[1])
    .filter((state) => VALID_STATES.has(state));
  if (labelled.length) return labelled[0];

  const stateName = Object.keys(STATE_BY_NAME).sort((left, right) => right.length - left.length)
    .find((name) => name.includes(" ")
      ? context.includes(name)
      : new RegExp(`\\b(?:ESTADO(?:\\s+DE)?|UF)\\s*[:.-]?\\s*${name}\\b`).test(context));
  if (stateName) return STATE_BY_NAME[stateName];

  const standalone = [...context.matchAll(/\b[A-Z]{2}\b/g)]
    .map((match) => match[0])
    .filter((state) => VALID_STATES.has(state));
  return standalone[0];
}

export function resolveSupplierIdentity(input: {
  accessKey?: string | null;
  extractedText?: string | null;
  supplierHeaderText?: string | null;
  supplierCity?: string | null;
  supplierName?: string | null;
  supplierCnpj?: string | null;
}) {
  const accessKey = findValidFiscalAccessKey(input.accessKey, input.extractedText, input.supplierHeaderText);
  const keyCnpj = accessKey ? formatCnpj(accessKey.slice(6, 20)) : undefined;
  const supplierCnpj = keyCnpj ?? resolveHeaderCnpj(input.supplierHeaderText, input.supplierCnpj);
  const supplierEvidence = [issuerSection(input.extractedText), issuerSection(input.supplierHeaderText), input.supplierCity]
    .filter(Boolean).join("\n");
  const supplierState = accessKey
    ? STATE_BY_CUF[accessKey.slice(0, 2)]
    : inferSupplierStateFromHeader(supplierEvidence, input.supplierName, supplierCnpj);
  return { supplierCnpj, supplierState };
}
