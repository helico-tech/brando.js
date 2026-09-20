import type { Brando } from '../../src/runtime.js';
export type View = 'Overview' | 'Actors' | 'Invocations' | 'Reminders' | 'Catalogue' | 'Runtime';
export type Overview = Awaited<ReturnType<Brando['overview']>>;
export type Row = Record<string, unknown>;
export type Catalogue = ReturnType<Brando['catalogue']>;
