import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-ink text-surface hover:opacity-90',
  secondary: 'border border-border bg-raised text-ink hover:bg-surface',
};

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={cn(
        'inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-medium',
        'transition-opacity outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink',
        // A disabled control still has to be readable: it explains why it is
        // disabled by what it says, and greying it into the background hides
        // that.
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANT[variant],
        className,
      )}
      {...props}
    />
  );
}
