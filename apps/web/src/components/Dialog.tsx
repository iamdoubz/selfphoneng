// SPDX-License-Identifier: AGPL-3.0-or-later
// Native <dialog> (focus trap + Esc for free) as a centered modal or a right-hand drawer.
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './ui.tsx';

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  drawer = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const shape = drawer
    ? 'ml-auto mr-0 h-dvh max-h-dvh w-full max-w-md'
    : 'm-auto w-[calc(100%-2rem)] max-w-md rounded-lg';
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="dialog-title"
      className={`${shape} bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:bg-zinc-900 dark:text-zinc-100`}
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 id="dialog-title" className="text-base font-semibold">
            {title}
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close" className="px-2 py-1">
            ✕
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
            {footer}
          </footer>
        )}
      </div>
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
  error,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {message}
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Dialog>
  );
}
