import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { soundsApi, soundsQueryKeys } from '../api/sounds';
import { SoundFamiliesNav } from '../editor/SoundsView';
import { SoundBrowser } from '../editor/sounds/SoundBrowser';
import { AppHeader } from '../layout/AppHeader';

/**
 * The sound library outside a song: the same browser as a song's Sounds tab
 * (families, search, styles, click to hear), without "Use", since no song is
 * open. Public names only, so it is open to everyone.
 */
export function SoundLibraryPage() {
  const families = useQuery({ queryKey: soundsQueryKeys.families, queryFn: ({ signal }) => soundsApi.families(signal), staleTime: Infinity });
  const [family, setFamily] = useState('keys');
  const transitionType = family.startsWith('transition:') ? family.slice('transition:'.length) : undefined;
  const title = transitionType
    ? families.data?.transitions.find((t) => t.type === transitionType)?.label
    : families.data?.families.find((f) => f.id === family)?.label;
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-white">
      <AppHeader />
      <div className="flex min-h-0 flex-1 bg-[#1b1c1f]">
        <SoundFamiliesNav families={families} family={family} onFamily={setFamily} />
        <SoundBrowser source={transitionType ? { transition: transitionType } : { family }} title={title ?? 'Sounds'} actionLabel="" action={() => null} />
      </div>
    </div>
  );
}
