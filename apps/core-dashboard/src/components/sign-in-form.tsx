'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Logo } from './logo';
import { NewKey } from './new-key';

/**
 * Deliberately loose.
 *
 * Its job is to catch a typo before a round trip, not to rule on what an
 * address may be: the real rules are stranger than any expression people write
 * for them, and refusing a valid address is worse than passing a wrong one to
 * be refused with a clear answer.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Errors {
  email?: string;
  password?: string;
  form?: string;
}

export function SignInForm({ registrationOpen }: { registrationOpen: boolean | undefined }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [issuedKey, setIssuedKey] = useState<string>();

  const signingUp = registrationOpen === true;

  function validate(): Errors {
    const found: Errors = {};
    const address = email.trim();

    if (address.length === 0) found.email = 'Enter your email address';
    else if (!LOOKS_LIKE_EMAIL.test(address)) found.email = 'That does not look like an email address';

    if (password.length === 0) found.password = signingUp ? 'Enter a password' : 'Enter your password';

    return found;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);

    try {
      const response = await fetch(`/api/auth/${signingUp ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const body = (await response.json()) as { error?: string; apiKey?: string };

      if (!response.ok) {
        setErrors({ form: body.error ?? 'That did not work. Try again.' });

        return;
      }

      if (body.apiKey !== undefined) {
        // Signing up hands over a key, and this is the only time it can be
        // read. Going straight to the dashboard would throw it away.
        setIssuedKey(body.apiKey);

        return;
      }

      router.push('/');
      router.refresh();
    } catch {
      setErrors({ form: 'Could not reach the server. Is it running?' });
    } finally {
      setSubmitting(false);
    }
  }

  if (issuedKey !== undefined) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Your account is ready</h1>
          <p className="mt-1 text-sm text-ink-muted">One thing before you go on.</p>
        </div>

        <NewKey value={issuedKey} />

        <Button
          onClick={() => {
            router.push('/');
            router.refresh();
          }}
          className="w-full"
        >
          I have copied it
        </Button>
      </div>
    );
  }

  return (
    <>
      <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
        <Logo size={32} />
        mcpspan
      </h1>
      <p className="mt-1 mb-6 text-sm text-ink-muted">
        {signingUp
          ? 'Nobody has set this installation up yet. Create the account.'
          : 'Sign in to see your server.'}
      </p>

      {/* The browser's own validation is turned off so the messages read the
          same everywhere and can be tied to their fields properly. */}
      <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          {...(errors.email === undefined ? {} : { error: errors.email })}
        />

        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete={signingUp ? 'new-password' : 'current-password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          {...(errors.password === undefined ? {} : { error: errors.password })}
        />

        {errors.form === undefined ? null : (
          <p role="alert" className="text-sm text-status-critical">
            {errors.form}
          </p>
        )}

        <Button type="submit" disabled={submitting} className="mt-2">
          {submitting
            ? signingUp
              ? 'Creating...'
              : 'Signing in...'
            : signingUp
              ? 'Create account'
              : 'Sign in'}
        </Button>
      </form>

      {signingUp ? null : (
        <p className="mt-6 text-xs text-ink-muted">
          Forgot the password? On the machine running mcpspan,{' '}
          <code className="font-mono [overflow-wrap:anywhere]">
            docker compose exec api node scripts/reset-password.ts
          </code>{' '}
          prints a new one.
        </p>
      )}
    </>
  );
}
