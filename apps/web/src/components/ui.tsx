// SPDX-License-Identifier: AGPL-3.0-or-later
// Small form building blocks shared by every page.
import { useId, type ComponentProps, type ReactNode } from 'react';

const focus =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500';

const variants = {
  primary: 'bg-sky-600 text-white hover:bg-sky-700 disabled:bg-sky-600/50',
  secondary:
    'border border-zinc-300 bg-white hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50',
  ghost: 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: keyof typeof variants }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed ${variants[variant]} ${focus} ${className}`}
      {...props}
    />
  );
}

export const inputClass = `w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 ${focus} aria-invalid:border-red-500`;

/** Label + control + error text. `children` gets the id and aria props to spread on the control. */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: (a: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        'aria-invalid': Boolean(error),
        'aria-describedby': error || hint ? msgId : undefined,
      })}
      {(error || hint) && (
        <p
          id={msgId}
          className={`text-xs ${error ? 'text-red-600 dark:text-red-400' : 'text-zinc-500'}`}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      {children}
    </p>
  );
}
