import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

// ---------- Modal ----------

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (ref.current?.contains(previous)) return () => previous?.focus(); // a field already claimed focus (autoFocus)
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.close)');
    (first ?? ref.current)?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- Confirm ----------

interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}
type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>((o) => new Promise((resolve) => setState({ ...o, resolve })), []);
  const done = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => done(false)}>
          <div className="modal-body">{state.message}</div>
          <div className="modal-actions">
            <button type="button" onClick={() => done(false)}>
              Cancel
            </button>
            <button type="button" className={state.danger ? 'd solid' : 'p'} onClick={() => done(true)}>
              {state.confirmLabel}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

// ---------- Toasts ----------

interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}
interface ToastApi {
  ok: (text: string) => void;
  error: (text: string) => void;
}
const ToastContext = createContext<ToastApi>({ ok: () => {}, error: () => {} });
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 5000);
  }, []);
  const api = useMemo<ToastApi>(() => ({ ok: (t) => push('ok', t), error: (t) => push('error', t) }), [push]);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts">
        <div role="status" aria-live="polite">
          {toasts.filter((t) => t.kind === 'ok').map((t) => (
            <div key={t.id} className="toast ok" onClick={() => dismiss(t.id)}>
              {t.text}
            </div>
          ))}
        </div>
        <div role="alert">
          {toasts.filter((t) => t.kind === 'error').map((t) => (
            <div key={t.id} className="toast error" onClick={() => dismiss(t.id)}>
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
