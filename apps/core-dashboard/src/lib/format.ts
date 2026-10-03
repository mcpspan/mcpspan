/**
 * Names the clients we recognise.
 *
 * The API stores whatever a client called itself, so this only prettifies the
 * ones we know and leaves anything else as reported. Inventing a friendly name
 * for an unfamiliar client would hide the one thing worth noticing about it.
 */
const CLIENT_NAMES: Record<string, string> = {
  claude: 'Claude',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  chatgpt: 'ChatGPT',
  'mcp-inspector': 'MCP Inspector',
  other: 'Other',
  unknown: 'Unidentified',
};

export function clientLabel(clientType: string): string {
  return CLIENT_NAMES[clientType] ?? clientType;
}

/** Thousands separated, so six digits can be read at a glance. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * A duration in the unit that suits its size.
 *
 * Milliseconds past a second become unreadable: nobody parses 1,432 ms as
 * "about a second and a half" without stopping to count digits.
 */
export function formatDuration(ms: number | null): { value: string; unit: string } {
  if (ms === null) return { value: '-', unit: '' };
  if (ms >= 1_000) return { value: (ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1), unit: 's' };
  if (ms >= 10) return { value: Math.round(ms).toString(), unit: 'ms' };

  return { value: ms.toFixed(1), unit: 'ms' };
}

/** A length of time a person reads at a glance: 45s, 3m 20s, 1h 5m. */
export function formatSpan(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;

  return minutes % 60 === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A rate as a percentage, keeping a small one from rounding away to nothing.
 *
 * Three failures in ten thousand calls is 0.03 percent. Rounded to whole
 * numbers that is zero, and a dashboard claiming no errors while errors are
 * happening is worse than one that says nothing at all.
 */
export function formatRate(rate: number): string {
  const percent = rate * 100;

  if (percent === 0) return '0';
  if (percent < 0.1) return '<0.1';

  return percent.toFixed(percent < 10 ? 1 : 0);
}

interface ErrorSourceInfo {
  value: string;
  label: string;
  /** Said under a failure that carries no message of its own. */
  explanation?: string;
}

/**
 * The ways a call can fail, in the words the interface uses for them.
 *
 * The last two never reach a handler: the server refuses them itself. They
 * carry no message, because the server's text for them can quote back what
 * the agent sent, so the explanation stands in for one.
 */
export const ERROR_SOURCES: readonly ErrorSourceInfo[] = [
  { value: 'exception', label: 'Crashed' },
  { value: 'result', label: 'Reported' },
  {
    value: 'arguments',
    label: 'Invalid arguments',
    explanation: "The tool's schema refused the arguments before the handler ran.",
  },
  {
    value: 'unknown_tool',
    label: 'Unknown tool',
    explanation: 'The server has no enabled tool by this name.',
  },
  {
    value: 'unknown_resource',
    label: 'Unknown resource',
    explanation: 'The server has nothing at this address. Only its scheme is kept: the rest came from the client.',
  },
  {
    value: 'unknown_prompt',
    label: 'Unknown prompt',
    explanation: 'The server has no prompt by this name.',
  },
];

/** What refused arguments mean for a prompt, where there is no schema, only arguments it requires. */
const PROMPT_ARGUMENTS = 'The prompt was asked for without an argument it requires, and refused before it ran.';

export function errorSourceInfo(source: string, kind?: string): ErrorSourceInfo {
  const info = ERROR_SOURCES.find((entry) => entry.value === source);
  if (info?.value === 'arguments' && kind === 'prompt') return { ...info, explanation: PROMPT_ARGUMENTS };

  return (
    info ?? {
      value: source,
      label: source,
    }
  );
}

/** A word to put before what an agent called, when it was not a tool. */
export function kindLabel(kind: string | null): string | null {
  return kind === 'resource' ? 'Resource' : kind === 'prompt' ? 'Prompt' : null;
}
