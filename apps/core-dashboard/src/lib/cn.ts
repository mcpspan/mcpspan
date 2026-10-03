import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Joins class names, letting a later utility win over an earlier one.
 *
 * Without the merge, passing `p-6` to a component that already sets `p-4`
 * produces both, and which one applies comes down to the order they happen to
 * sit in the stylesheet.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
