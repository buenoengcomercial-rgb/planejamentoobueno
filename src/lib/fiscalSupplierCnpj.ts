function cnpjDigits(value?: string | null) {
  return String(value ?? '').replace(/\D/g, '');
}

export function isValidCnpj(value?: string | null) {
  const digits = cnpjDigits(value);
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;
  const calculate = (length: number) => {
    let weight = length - 7;
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * weight--;
      if (weight < 2) weight = 9;
    }
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return calculate(12) === Number(digits[12]) && calculate(13) === Number(digits[13]);
}

export function formatCnpj(value?: string | null) {
  const digits = cnpjDigits(value);
  if (!isValidCnpj(digits)) return undefined;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

export function inferSupplierCnpjFromHeader(headerText?: string | null) {
  const text = String(headerText ?? '');
  const labels = [...text.matchAll(/CNPJ\s*\/?\s*CPF/gi)];
  for (const label of labels) {
    const afterLabel = text.slice((label.index ?? 0) + label[0].length, (label.index ?? 0) + label[0].length + 120);
    const candidates = afterLabel.match(/(?<!\d)(?:\d[\s./-]*){14}(?!\d)/g) ?? [];
    for (const candidate of candidates) {
      const formatted = formatCnpj(candidate);
      if (formatted) return formatted;
    }
  }
  return undefined;
}

/** Prefer the labeled issuer header and reject a CNPJ returned from another document block. */
export function resolveSupplierCnpj(headerText?: string | null, aiCnpj?: string | null) {
  const inferred = inferSupplierCnpjFromHeader(headerText);
  if (inferred) return inferred;
  const formattedAi = formatCnpj(aiCnpj);
  if (!formattedAi) return undefined;
  const headerDigits = cnpjDigits(headerText);
  const aiDigits = cnpjDigits(formattedAi);
  if (headerText?.trim() && !headerDigits.includes(aiDigits)) return undefined;
  return formattedAi;
}
