// A song version: the saved song text (which also names its vocal takes, by fingerprint) plus the mix config it
// plays with, the standard one or with its Pro-mode changes applied. The browser measures track levels for the
// version its playback payload carries; the console video checks it renders that same version.

import { createHash } from 'node:crypto';

import { applyMixOverrides, type MixOverrides } from '@casperaki/song-schema';

export function songVersionKey(canonical: string, mixConfig: string): string {
  return createHash('sha256').update(`${canonical}\u0000${mixConfig}`, 'utf8').digest('hex').slice(0, 16);
}

/** The song's own mix config (its Pro-mode changes applied), or undefined when it plays the standard mix. */
export function songMixConfig(project: { mixOverrides: MixOverrides | null }, baseMixConfig: (() => string) | undefined): string | undefined {
  if (!project.mixOverrides) return undefined;
  if (!baseMixConfig) throw new Error('This song has a Pro-mode mix, but the brain has no mix config (CASPERAKI_MIX_CONFIG).');
  return applyMixOverrides(baseMixConfig(), project.mixOverrides);
}
