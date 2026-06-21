import type { InputHTMLAttributes, SelectHTMLAttributes, ButtonHTMLAttributes } from 'react';

/**
 * Form primitives tuned for a dense workbench: 36px tall, mono-ish
 * neutral surfaces, accent-on-focus borrowed from the rory-fe red.
 */

const baseField =
  'h-9 px-3 rounded-md border border-line bg-panel-2 text-fg text-[13px] ' +
  'focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/40 ' +
  'placeholder:text-dim disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input {...rest} className={`${baseField} ${className}`} />;
}

export function NumberInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input type="number" {...rest} className={`${baseField} font-mono ${className}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', children, ...rest } = props;
  return (
    <select {...rest} className={`${baseField} pr-8 ${className}`}>
      {children}
    </select>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'primary' | 'secondary' | 'ghost';
}

export function Button({ variant = 'secondary', className = '', children, ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 h-9 px-4 rounded-md text-[13px] font-semibold ' +
    'transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const variants: Record<NonNullable<ButtonProps['variant']>, string> = {
    primary: 'bg-accent text-white hover:bg-accent/90',
    secondary: 'bg-panel-2 text-fg border border-line hover:border-dim',
    ghost: 'text-muted hover:text-fg hover:bg-panel-2',
  };
  return (
    <button {...rest} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}
