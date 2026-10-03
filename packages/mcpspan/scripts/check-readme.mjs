/**
 * Typechecks every TypeScript sample in README.md against the built package.
 *
 * The README is the first thing a reader runs, and a sample that no longer
 * compiles is worse than no sample: it reads as authoritative. Prose can drift
 * quietly, but this part of it does not have to. The samples are concatenated
 * into one file inside the package, so `import ... from 'mcpspan'` resolves
 * through the real `exports` map to the emitted declarations - the same route
 * an installed copy takes, rather than a shortcut to `src`.
 *
 * Requires `pnpm build` to have run. Exits non-zero on the first error.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const samplesFile = join(packageDir, 'readme-samples.generated.ts');
const configFile = join(packageDir, 'tsconfig.readme.json');

const readme = readFileSync(join(packageDir, 'README.md'), 'utf8');
const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]);

if (blocks.length === 0) {
  console.error('No TypeScript samples found in README.md. Did the fences change?');
  process.exit(1);
}

// Samples are written for a reader who already has a schema to hand, so they
// use one without defining it. Everything else has to come from the package.
const preamble = `declare const inputSchema: Record<string, never>;\n`;

const imports = [];
const bodies = [];

// Named imports from one module are merged, since two samples that each take
// something from 'mcpspan' would otherwise declare the same name twice.
const named = new Map();

function addImport(line) {
  const match = /^import \{([^}]*)\} from '([^']+)';$/.exec(line);

  if (match === null) {
    if (!imports.includes(line)) imports.push(line);
    return;
  }

  const names = named.get(match[2]) ?? new Set();
  named.set(match[2], names);
  for (const name of match[1].split(',')) {
    if (name.trim() !== '') names.add(name.trim());
  }
}

blocks.forEach((block, index) => {
  const rest = [];
  for (const line of block.trimEnd().split('\n')) {
    if (line.startsWith('import ')) {
      addImport(line);
    } else {
      rest.push(line);
    }
  }
  bodies.push(`// ---- README sample ${index + 1} ----\n${rest.join('\n').trim()}`);
});

for (const [module, names] of named) {
  imports.push(`import { ${[...names].join(', ')} } from '${module}';`);
}

writeFileSync(samplesFile, `${preamble}\n${imports.join('\n')}\n\n${bodies.join('\n\n')}\n`);
writeFileSync(
  configFile,
  `${JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      // Samples are fragments: a value named to show what comes back is not
      // then used, and that is the point of it.
      compilerOptions: { noEmit: true, types: ['node'], noUnusedLocals: false, noUnusedParameters: false },
      include: ['readme-samples.generated.ts'],
    },
    null,
    2,
  )}\n`,
);

try {
  const result = spawnSync('npx', ['tsc', '-p', configFile], {
    cwd: packageDir,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.error(`\n${blocks.length} README sample(s) checked, and at least one does not compile.`);
    process.exit(result.status ?? 1);
  }

  console.log(`All ${blocks.length} README samples compile against the built package.`);
} finally {
  rmSync(samplesFile, { force: true });
  rmSync(configFile, { force: true });
}
