// Public instrument names at runtime.
//
// `data/instrument-aliases.json` maps each style-free sound identity
// (deriveSoundIdentity) to its public `<Adjective> <Noun>` name. The
// catalog export writes it; this loader is what the brain uses to show
// those names instead of the underlying library / preset names.
//
// Every catalog entry must have a name: a missing one means the registry
// is stale (run `pnpm -C packages/arrangement catalog:export` to fill the
// gaps), and publicNameOf throws rather than inventing a substitute.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { deriveSoundIdentity } from './alias.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(HERE, '..', '..', 'data', 'instrument-aliases.json');

const RegistryFileSchema = z.object({
  aliases: z.record(z.string(), z.string().min(1)),
});

let cached: ReadonlyMap<string, string> | undefined;

/** Sound identity → public name, loaded once per process. */
export function loadPublicNames(): ReadonlyMap<string, string> {
  if (cached) return cached;
  const parsed = RegistryFileSchema.parse(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')));
  cached = new Map(Object.entries(parsed.aliases));
  return cached;
}

type IdentityFields = Parameters<typeof deriveSoundIdentity>[0];

/** The public name of a catalog entry. Throws when the registry has none. */
export function publicNameOf(
  entry: IdentityFields & { readonly id: string },
  names: ReadonlyMap<string, string> = loadPublicNames(),
): string {
  const identity = deriveSoundIdentity(entry);
  const name = names.get(identity);
  if (name === undefined) {
    throw new Error(
      `Catalog entry ${entry.id} (sound identity ${identity}) has no public name in ` +
        `data/instrument-aliases.json. Run \`pnpm -C packages/arrangement catalog:export\` to fill it.`,
    );
  }
  return name;
}
