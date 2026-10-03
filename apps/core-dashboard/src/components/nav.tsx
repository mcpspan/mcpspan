'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/calls', label: 'Calls' },
  { href: '/errors', label: 'Errors' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/status', label: 'Status' },
  { href: '/settings', label: 'Settings' },
] as const;

/**
 * Moving between the views.
 *
 * A client component only because it has to know which page is open. The
 * layout around it stays on the server, so this is the only part of the shell
 * the browser has to download.
 *
 * The current page is marked for assistive technology as well as visually:
 * somebody listening to the page hears which section they are in rather than
 * having to infer it from a colour they cannot see.
 */
export function Nav({ vertical = false }: { vertical?: boolean }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Sections" className={cn('flex gap-1', vertical && 'flex-col')}>
      {LINKS.map((link) => {
        const current = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink',
              current ? 'bg-surface font-medium text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The shell's controls on a narrow screen: one button, and the sections,
 * the server and signing out beneath it when it is open.
 *
 * Five sections, a server menu and a sign-out button do not fit across a
 * phone; wrapped onto three lines they pushed every page down, and at the
 * narrowest widths still ran off the side. The panel drops down under the
 * header as a disclosure, not a dialog: nothing else is blocked, so there is
 * no focus to trap. It closes when a link is followed, on a click outside it,
 * and on Escape, which hands focus back to the button that opened it.
 */
export function MobileMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const pathname = usePathname();
  const params = useSearchParams().toString();

  // A followed link, or a different server chosen, is somewhere new: the
  // menu has done its job.
  useEffect(() => {
    setOpen(false);
  }, [pathname, params]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    }
    function onPointerDown(event: PointerEvent): void {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div ref={menu} className="md:hidden">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-ink-muted outline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
      >
        {open ? <X aria-hidden className="size-4" /> : <Menu aria-hidden className="size-4" />}
        Menu
      </button>

      {open ? (
        <div id={panelId} className="absolute inset-x-0 top-full z-10 border-b border-border bg-raised px-6 pt-2 pb-4 shadow-sm">
          <Nav vertical />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            {children}
          </div>
        </div>
      ) : null}
    </div>
  );
}
