// SPDX-License-Identifier: AGPL-3.0-or-later
// Small form building blocks shared by every page.
import { useId, type ComponentProps, type ReactNode } from 'react';
import { APP_NAME } from '@selfphoneng/shared';

export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

const variants = {
  primary: 'bg-primary text-white hover:bg-primary-hover disabled:bg-primary/50',
  secondary: 'border border-line-strong bg-surface hover:bg-subtle',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50',
  ghost: 'hover:bg-subtle',
};

/** The icon (public/icon-192.png, cut from public/logo.png) and the product name. */
export function Brand({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold ${className}`}>
      <img src="/icon-192.png" alt="" className="size-7 rounded-md" />
      {APP_NAME}
    </span>
  );
}

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: keyof typeof variants }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${variants[variant]} ${focusRing} ${className}`}
      {...props}
    />
  );
}

/** A titled card: heading, an optional link or button on the right, then the body. */
export function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export const inputClass = `w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm ${focusRing} aria-invalid:border-red-500`;

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
          className={`text-xs ${error ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}
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
