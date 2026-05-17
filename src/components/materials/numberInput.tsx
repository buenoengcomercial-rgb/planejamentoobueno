import * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Converte string com vírgula decimal BR para número.
 * Aceita "10,50", "10.50", "1.000,50" e "1,000.50".
 */
export function parseBR(value: string | number | undefined | null): number | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  // Mantém apenas dígitos, vírgula, ponto e sinal de menos.
  let s = raw.replace(/[^\d.,-]/g, '');
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // Assume ponto = separador de milhar, vírgula = decimal.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

interface NumberInputProps extends Omit<React.ComponentProps<typeof Input>, 'onChange' | 'value' | 'type'> {
  value: string;
  onChange: (raw: string) => void;
  decimal?: boolean;
}

/**
 * Input numérico amigável a pt-BR: sem setas, aceita vírgula decimal.
 * Mantém o texto bruto durante a digitação (controlled string).
 */
export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ value, onChange, decimal = true, className, ...rest }, ref) => {
    return (
      <Input
        ref={ref}
        type="text"
        inputMode={decimal ? 'decimal' : 'numeric'}
        value={value}
        onChange={e => {
          const v = e.target.value;
          // Aceita apenas dígitos, vírgula, ponto, sinal e separadores.
          if (v === '' || /^-?[\d.,]*$/.test(v)) onChange(v);
        }}
        className={cn('[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none', className)}
        {...rest}
      />
    );
  },
);
NumberInput.displayName = 'NumberInput';

/** Trunca em 2 casas decimais (sem arredondar para cima). */
export function trunc2(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(Number(value))) return 0;
  return Math.trunc((Number(value) + Number.EPSILON) * 100) / 100;
}

/** Formata número como moeda BR (R$ 1.234,56). */
export function formatBRL(value: number | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Formata número com truncamento de 2 casas e separadores BR (sem R$). */
export function formatQty(value: number | null | undefined): string {
  return trunc2(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface CurrencyInputProps extends Omit<React.ComponentProps<typeof Input>, 'onChange' | 'value' | 'type'> {
  /** Valor numérico (em reais). */
  value: number | undefined | null;
  onChange: (next: number | undefined) => void;
}

/**
 * Input de moeda BRL: mostra "R$ 1.234,56" quando desfocado e número editável quando focado.
 */
export const CurrencyInput = React.forwardRef<HTMLInputElement, CurrencyInputProps>(
  ({ value, onChange, className, onFocus, onBlur, ...rest }, ref) => {
    const [focused, setFocused] = React.useState(false);
    const [draft, setDraft] = React.useState<string>('');
    const display = focused
      ? draft
      : value != null && Number.isFinite(Number(value))
        ? formatBRL(value)
        : '';
    return (
      <Input
        ref={ref}
        type="text"
        inputMode="decimal"
        value={display}
        onFocus={e => {
          setFocused(true);
          setDraft(value != null ? String(value).replace('.', ',') : '');
          onFocus?.(e);
        }}
        onChange={e => {
          const v = e.target.value;
          if (v === '' || /^-?[\d.,\sR$]*$/.test(v)) setDraft(v);
        }}
        onBlur={e => {
          setFocused(false);
          const parsed = parseBR(draft);
          onChange(parsed);
          onBlur?.(e);
        }}
        className={cn('[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none', className)}
        {...rest}
      />
    );
  },
);
CurrencyInput.displayName = 'CurrencyInput';
