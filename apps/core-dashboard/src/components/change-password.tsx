'use client';

import { CheckCircle2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';

interface Errors {
  current?: string;
  next?: string;
  repeat?: string;
  form?: string;
}

/**
 * Changes the password, knowing the current one.
 *
 * The new one is typed twice: a typo here would lock the owner out until they
 * reset it on the server.
 */
export function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [changed, setChanged] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setChanged(false);

    const found: Errors = {};
    if (current.length === 0) found.current = 'Enter the current password';
    if (next.length === 0) found.next = 'Enter a new password';
    else if (repeat !== next) found.repeat = 'The two do not match';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };

      if (response.status === 403) {
        setErrors({ current: body.error ?? 'That is not the current password' });
        return;
      }
      if (!response.ok) {
        setErrors({ form: body.error ?? 'That did not work. Try again.' });
        return;
      }

      setCurrent('');
      setNext('');
      setRepeat('');
      setChanged(true);
    } catch {
      setErrors({ form: 'Could not reach the server. Is it running?' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Field
        id="current-password"
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(event) => setCurrent(event.target.value)}
        {...(errors.current === undefined ? {} : { error: errors.current })}
      />
      <Field
        id="new-password"
        label="New password"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(event) => setNext(event.target.value)}
        {...(errors.next === undefined ? {} : { error: errors.next })}
      />
      <Field
        id="repeat-password"
        label="New password again"
        type="password"
        autoComplete="new-password"
        value={repeat}
        onChange={(event) => setRepeat(event.target.value)}
        {...(errors.repeat === undefined ? {} : { error: errors.repeat })}
      />

      {errors.form === undefined ? null : (
        <p role="alert" className="text-sm text-status-critical">
          {errors.form}
        </p>
      )}
      {changed ? (
        <p role="status" className="flex items-center gap-1.5 text-sm text-ink">
          <CheckCircle2 aria-hidden className="size-4 text-status-good" />
          Changed. Every other browser has been signed out.
        </p>
      ) : null}

      <Button type="submit" disabled={submitting} className="self-start">
        {submitting ? 'Changing...' : 'Change password'}
      </Button>
    </form>
  );
}
