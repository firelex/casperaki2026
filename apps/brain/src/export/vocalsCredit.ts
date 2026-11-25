/** The CC BY-NC 4.0 credit for the YuE2 vocal model. Same text as VOCALS_CREDIT in apps/web/src/layout/VocalsCredit.tsx. */
export const VOCALS_CREDIT = 'Vocals sung with YuE2 (m-a-p/YuE2-3B, https://huggingface.co/m-a-p/YuE2-3B), CC BY-NC 4.0';

/** Whether the canonical song JSON carries a YuE2 vocal take (then exports must carry the credit). */
export function hasYue2Take(canonical: string): boolean {
  const song = JSON.parse(canonical) as { aiArtifacts?: readonly { kind?: string }[] };
  if (!Array.isArray(song.aiArtifacts)) throw new Error('song has no aiArtifacts array');
  return song.aiArtifacts.some((a) => a.kind === 'yue2-vocal');
}
