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
