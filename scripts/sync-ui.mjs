import { mkdirSync, writeFileSync } from 'node:fs';
// Vendored, reviewable component source from the official shadcn registry.
for (const name of ['button', 'card', 'badge', 'input', 'textarea', 'dialog', 'table']) {
  const url = `https://ui.shadcn.com/r/styles/new-york/${name}.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const component = await response.json();
  for (const file of component.files) {
    const content = file.content.replaceAll('@/lib/utils', '../../lib/utils.js');
    mkdirSync('dashboard/src/components/ui', { recursive: true });
    writeFileSync(`dashboard/src/components/${file.path}`, content);
  }
  console.log(name, component.dependencies ?? []);
}
const license = await fetch('https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md');
if (!license.ok) throw new Error('Could not read shadcn license');
writeFileSync('dashboard/LICENSE', await license.text());
