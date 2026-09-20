import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
const [component, slug, title = slug] = process.argv.slice(2);
if (!/^[A-Z]+$/.test(component ?? '') || !/^[a-z0-9-]+$/.test(slug ?? ''))
  throw new Error('Usage: node scripts/new-work-item.mjs COMPONENT slug "Title"');
mkdirSync('docs/work', { recursive: true });
const next =
  1 +
  Math.max(
    0,
    ...readdirSync('docs/work').map((name) =>
      Number(name.match(new RegExp(`^${component}-(\\d+)-`))?.[1] ?? 0),
    ),
  );
const id = `${component}-${String(next).padStart(4, '0')}`;
writeFileSync(`docs/work/${id}-${slug}.md`, `---\nstatus: active\n---\n# ${id}: ${title}\n\n`);
console.log(id);
