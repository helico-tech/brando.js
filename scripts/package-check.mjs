import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('.');
const directory = resolve('docs/context/.package-check');
const env = { ...process.env };
delete env.NO_COLOR;
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with ${result.status}`);
}
mkdirSync(directory, { recursive: true });
try {
  run('pnpm', ['pack', '--pack-destination', directory]);
  const tarball = readdirSync(directory).find((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('Package tarball missing');
  writeFileSync(
    `${directory}/package.json`,
    JSON.stringify(
      {
        name: 'brando-package-consumer',
        version: '1.0.0',
        private: true,
        type: 'module',
        dependencies: {
          '@helico-tech/brando.js': `file:./${tarball}`,
          zod: JSON.parse(readFileSync('package.json')).dependencies.zod,
        },
        devDependencies: {
          typescript: JSON.parse(readFileSync('package.json')).devDependencies.typescript,
          '@types/node': '^24',
        },
      },
      null,
      2,
    ),
  );
  run('pnpm', ['install', '--ignore-workspace'], directory);
  writeFileSync(
    `${directory}/consumer.mjs`,
    `import assert from 'node:assert/strict';
import { z } from 'zod';
import { actorType, codec, defineActor, message } from '@helico-tech/brando.js';
import { actorTurnTest } from '@helico-tech/brando.js/testing';
import { rateLimiter } from '@helico-tech/brando.js/primitives';
import { createDashboardServer } from '@helico-tech/brando.js/http';
const type=actorType({name:'consumer',id:codec('string',z.string())});
const add=message({name:'add',payload:z.object({amount:z.number()}),result:codec('number',z.number())});
const actor=defineActor({type,state:codec('state',z.object({value:z.number()})),initial:()=>({value:0}),handlers:on=>[on(add,(ctx,p)=>ctx.update(s=>({value:s.value+p.amount})).value)]});
const turn=await actorTurnTest({actors:[actor],actor,id:'a',message:add,payload:{amount:3}});
assert.equal(turn.result,3);assert.equal(turn.state.value,3);assert.equal(typeof rateLimiter,'function');assert.equal(typeof createDashboardServer,'function');
console.log('Installed ESM consumer and all subpath exports passed.');`,
  );
  writeFileSync(
    `${directory}/consumer.ts`,
    `import { z } from 'zod';
import { actorType, codec, defineActor, message, type Brando } from '@helico-tech/brando.js';
const type=actorType({name:'typed',id:codec('string',z.string())});
const add=message({name:'add',payload:z.object({amount:z.number()}),result:codec('number',z.number())});
export const actor=defineActor({type,state:codec('state',z.object({value:z.number()})),initial:()=>({value:0}),handlers:on=>[on(add,(ctx,p)=>ctx.update(s=>({value:s.value+p.amount})).value)]});
export async function use(runtime:Brando):Promise<number>{return runtime.call({target:type.ref('a'),message:add,payload:{amount:1}});}`,
  );
  run('node', ['consumer.mjs'], directory);
  run(
    'node',
    [
      '--input-type=commonjs',
      '-e',
      `const assert = require('node:assert/strict'); assert.equal(typeof require('@helico-tech/brando.js').Brando.start, 'function'); console.log('Installed CommonJS consumer passed.');`,
    ],
    directory,
  );
  run(
    'pnpm',
    [
      'exec',
      'tsc',
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--module',
      'nodenext',
      '--target',
      'es2024',
      'consumer.ts',
    ],
    directory,
  );
  console.log('Installed TypeScript consumer passed.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
