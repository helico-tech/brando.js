import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
const root = 'docs/issues';
mkdirSync(root, { recursive: true });
const [command = 'list', ...args] = process.argv.slice(2);
const today = new Date().toISOString().slice(0, 10);
const files = () =>
  readdirSync(root)
    .filter((name) => name.endsWith('.md'))
    .sort();
if (command === 'new') {
  const [priority, slug, title = slug] = args;
  if (!/^P[0-3]$/.test(priority ?? '') || !/^[a-z0-9-]+$/.test(slug ?? ''))
    throw new Error('new P0|P1|P2|P3 slug title');
  writeFileSync(
    `${root}/${today}-${slug}.md`,
    `---\nstatus: open\npriority: ${priority}\nfiled: ${today}\nfiled-by: agent\n---\n# ${title}\n`,
    { flag: 'wx' },
  );
} else if (command === 'resolve') {
  const [file, work, commit, ...notes] = args;
  if (!files().includes(file) || !/^[A-Z]+-\d{4}$/.test(work ?? '') || !commit)
    throw new Error('resolve filename WORK-0000 commit notes');
  const path = `${root}/${file}`;
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(/^status: .+$/m, 'status: resolved') +
      `\nResolved ${today}, ${work}, commit ${commit}: ${notes.join(' ')}\n`,
  );
} else if (command === 'validate' || command === 'list') {
  const records = files().map((file) => {
    const text = readFileSync(`${root}/${file}`, 'utf8');
    if (
      !/^\d{4}-\d{2}-\d{2}-/.test(file) ||
      !/^---\nstatus: (open|triaged|resolved|wontfix)\npriority: P[0-3]\nfiled: \d{4}-\d{2}-\d{2}\nfiled-by: .+\n/.test(
        text,
      ) ||
      (text.includes('status: triaged') && !/^work: [A-Z]+-\d{4}$/m.test(text))
    )
      throw new Error(`Malformed issue ${file}`);
    return {
      file,
      priority: text.match(/^priority: (P\d)$/m)[1],
      status: text.match(/^status: (\w+)$/m)[1],
    };
  });
  if (command === 'list')
    console.log(
      records
        .filter((r) => ['open', 'triaged'].includes(r.status))
        .sort((a, b) => a.priority.localeCompare(b.priority) || a.file.localeCompare(b.file)),
    );
  else console.log(`Validated ${records.length} issues.`);
} else throw new Error(`Unknown command ${command}`);
