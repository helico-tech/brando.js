import { copyFileSync } from 'node:fs';
copyFileSync('dashboard/LICENSE', 'dist/dashboard/SHADCN-LICENSE');
copyFileSync('node_modules/@fontsource-variable/inter/LICENSE', 'dist/dashboard/INTER-LICENSE');
