import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const directories = new Set([
  'src',
  'tests',
  'examples',
  'dashboard',
  'scripts',
  'docs',
  '.github',
  '.githooks',
]);
const files = new Set([
  '.env.example',
  '.gitignore',
  '.prettierignore',
  '.prettierrc.json',
  'LICENSE',
  'NOTICE',
  'README.md',
  'compose.yaml',
  'eslint.config.js',
  'package.json',
  'playwright.config.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.build.json',
  'vitest.config.ts',
]);
const categories = new Set(['adr', 'specs', 'work', 'issues', 'domain', 'context']);
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);
for (const path of paths) {
  const [root, category, name] = path.split('/');
  if (!directories.has(root) && !files.has(path))
    throw new Error(`Undeclared repository path: ${path}`);
  if (root !== 'docs') continue;
  if (!categories.has(category)) throw new Error(`Undeclared docs category: ${path}`);
  if (['adr', 'specs', 'issues'].includes(category) && !/^\d{4}-\d{2}-\d{2}-/.test(name ?? ''))
    throw new Error(`Dated filename required: ${path}`);
  if (category === 'adr' && !/^\d{4}-\d{2}-\d{2}-\d{4}-/.test(name))
    throw new Error(`ADR sequence required: ${path}`);
  if (
    category === 'work' &&
    (!/^[A-Z]+-\d{4}-[a-z0-9-]+\.md$/.test(name) ||
      !/^---\nstatus: (active|complete|superseded)\n---/.test(readFileSync(path, 'utf8')))
  )
    throw new Error(`Malformed work item: ${path}`);
}
console.log(`Validated repository layout (${paths.length} files).`);
