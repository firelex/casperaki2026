// ACE layers (docs/superpowers/specs/2026-11-25-ace-layer-design.md): an extra instrument part ACE-Step played over
// the song, one clip per section on an audio-only track "ACE <Instrument>". The clips are AI artifacts like sung
// takes: stored as <sha256>.ogg in the takes directory and stamped with the fingerprint of the section they were
// played over (tempo and bars), so a later change to that section leaves its clip out.

import { z } from 'zod';

import { applyRapLyrics, isRapClip, muteUnderRap } from './rap.js';

import {
  ACE_INSTRUMENTS,
  ACE_LAYER_KIND,
  aceInstrumentOfTrack,
  parseSong,
  RAP_TRACK,
  Sha256Schema,
  type AIArtifact,
  type Song,
} from '@casperaki/song-schema';

export const ACE_MODEL_ID = 'ACE-Step/acestep-v15-base';

export const AceLayerResultSchema = z
  .object({
    track: z.string().min(1),
    instrument: z.enum(ACE_INSTRUMENTS),
    /** What ACE was asked for (the instrument's description, the user's words, tempo and key). */
    caption: z.string().min(1),
    seed: z.number().int(),
    takes: z
      .array(
        z
          .object({
            segment: z.string().min(1),
            sha256: Sha256Schema,
            durationSeconds: z.number().positive(),
            /** The section's fingerprint in the song the layer was played over (vocalTakeFingerprint). */
            fingerprint: Sha256Schema,
          })
          .strict(),
      )
      .min(1),
    /** Rap: the words each section was rapped with (section → lines), recorded as the song's rap lyrics. */
    rapLyrics: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).optional(),
  })
  .strict()
  .refine((r) => (r.rapLyrics !== undefined) === (r.instrument === 'rap'), 'rap results carry their words, and only rap results');
export type AceLayerResult = z.infer<typeof AceLayerResultSchema>;

/** The song with an ACE layer's clips on its track (replacing the track's earlier clips, if any). */
export function applyAceLayer(song: Song, result: AceLayerResult): Song {
  const layer = AceLayerResultSchema.parse(result);
  if (aceInstrumentOfTrack(layer.track) !== layer.instrument) {
    throw new Error(`applyAceLayer: "${layer.track}" is not a track name for an ACE ${layer.instrument} layer`);
  }
  if (song.instrumentDefinitions.some((d) => d.name === layer.track)) {
    throw new Error(`applyAceLayer: the song already has an instrument track named "${layer.track}"`);
  }
  for (const t of layer.takes) {
    if (!song.songStructure.some((s) => s.name === t.segment)) throw new Error(`applyAceLayer: the song has no section "${t.segment}"`);
  }
  // Rap (docs/superpowers/specs/2026-11-28-rap-like-singing-design.md) lands on "Rap" and replaces only the clips of
  // its own sections; the sung takes there are muted. Any other layer replaces its track's clips.
  const rap = layer.instrument === 'rap';
  if (rap && layer.track !== RAP_TRACK) throw new Error(`applyAceLayer: rap goes on the "${RAP_TRACK}" track, not "${layer.track}"`);
  const sections = new Set(layer.takes.map((t) => t.segment));
  // Rap replaces the clips of its sections on any rap track (an earlier "ACE Rap" one too, or both would play).
  const onTrack = (a: AIArtifact) =>
    rap
      ? isRapClip(a) && a.attachedTo.scope === 'segment' && sections.has(a.attachedTo.segment)
      : a.kind === ACE_LAYER_KIND && a.attachedTo.scope === 'segment' && a.attachedTo.instrument === layer.track;
  const artifacts: AIArtifact[] = layer.takes.map((t) => ({
    id: `${ACE_LAYER_KIND}:${t.segment}:${layer.track}:${t.sha256.slice(0, 8)}`,
    kind: ACE_LAYER_KIND,
    modelId: ACE_MODEL_ID,
    modelVersion: rap ? 'repaint' : 'lego',
    seed: layer.seed,
    prompt: layer.caption,
    conditioning: { hashes: [t.fingerprint] },
    output: { uri: `vocal-take:${t.sha256}.ogg`, sha256: t.sha256, durationSeconds: t.durationSeconds },
    attachedTo: { scope: 'segment', segment: t.segment, instrument: layer.track },
  }));
  const out = parseSong({ ...song, aiArtifacts: [...song.aiArtifacts.filter((a) => !onTrack(a)), ...artifacts] });
  return rap ? muteUnderRap(applyRapLyrics(out, layer.rapLyrics!), [...sections]) : out;
}
