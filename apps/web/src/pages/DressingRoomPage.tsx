import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { buildAvatar, packGroup, packItem, type Avatar, type AvatarRecipe, type PackItem, type PackManifest } from '@casperaki/video/avatar';

import { avatarPacksQueryKey, avatarsApi, avatarsQueryKey, packFileUrl, type AvatarInfo, type AvatarPackInfo } from '../api/avatars';
import { singersApi, singersQueryKey, type SingerInfo } from '../api/singers';
import { AvatarStage } from '../avatars/AvatarStage';
import {
  chooseColor,
  choosePart,
  chooseTexture,
  colorChoices,
  droppedText,
  groupCamera,
  groupLabel,
  isRequired,
  orderedGroups,
  partThumbnail,
  startingRecipe,
  textureChoices,
} from '../avatars/recipeEdit';
import { AppHeader } from '../layout/AppHeader';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The dressing room for a new avatar (/avatars/new) or one of the user's (/avatars/:id): the avatar in 3D on the
 * left, the choices on the right (pack, then skin, eyes, hair, clothes and accessories with their colourings and
 * tints), its name and voice, Save and Cancel.
 */
export function DressingRoomPage() {
  const { avatarId } = useParams<{ avatarId: string }>();
  const packs = useQuery({ queryKey: avatarPacksQueryKey, queryFn: ({ signal }) => avatarsApi.packs(signal), staleTime: Infinity });
  const avatars = useQuery({ queryKey: avatarsQueryKey, queryFn: ({ signal }) => avatarsApi.list(signal), enabled: avatarId !== undefined });
  const singers = useQuery({ queryKey: singersQueryKey, queryFn: ({ signal }) => singersApi.list(signal), staleTime: 60_000 });

  let body: ReactNode;
  const failed = [
    packs.isError ? `The avatar packs could not be loaded: ${message(packs.error)}` : undefined,
    avatars.isError ? `Your avatars could not be loaded: ${message(avatars.error)}` : undefined,
    singers.isError ? `The singers could not be loaded: ${message(singers.error)}` : undefined,
  ].filter((x): x is string => x !== undefined);
  if (failed.length > 0) {
    body = <Problem lines={failed} />;
  } else if (packs.isPending || singers.isPending || (avatarId !== undefined && avatars.isPending)) {
    body = <p className="p-8 text-[14px] text-white/55">Opening the dressing room…</p>;
  } else if (packs.data!.length === 0) {
    body = <Problem lines={['There are no avatar packs to dress avatars from.']} />;
  } else {
    const existing = avatarId === undefined ? undefined : avatars.data!.avatars.find((a) => a.id === avatarId);
    if (avatarId !== undefined && !existing) body = <Problem lines={[`You have no avatar with the id "${avatarId}".`]} />;
    else body = <DressingRoom key={avatarId ?? 'new'} packs={packs.data!} singers={singers.data!.singers} existing={existing} />;
  }
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-white">
      <AppHeader />
      {body}
    </div>
  );
}

function Problem({ lines }: { lines: readonly string[] }) {
  return (
    <div className="p-8" role="alert">
      {lines.map((l) => (
        <p key={l} className="text-[14px] text-err">
          {l}
        </p>
      ))}
    </div>
  );
}

function findPack(packs: readonly AvatarPackInfo[], name: string): AvatarPackInfo {
  const p = packs.find((x) => x.name === name);
  if (!p) throw new Error(`The avatar pack "${name}" is not available.`);
  return p;
}

export function DressingRoom({ packs, singers, existing }: { packs: readonly AvatarPackInfo[]; singers: readonly SingerInfo[]; existing: AvatarInfo | undefined }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [recipe, setRecipe] = useState<AvatarRecipe>(() => existing?.recipe ?? startingRecipe(packs[0]!.name, packs[0]!.manifest));
  const [name, setName] = useState(existing?.name ?? '');
  const [singerId, setSingerId] = useState<string | null>(existing?.singerId ?? null);
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [choiceError, setChoiceError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(true);
  const [buildError, setBuildError] = useState<string | undefined>(undefined);

  const pack = findPack(packs, recipe.pack);
  const manifest = pack.manifest;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<AvatarStage | null>(null);
  const shownRef = useRef<Avatar | null>(null);

  // The 3D view lives as long as the page.
  useEffect(() => {
    const stage = new AvatarStage(canvasRef.current!);
    stageRef.current = stage;
    return () => {
      stage.dispose();
      shownRef.current?.dispose();
      shownRef.current = null;
      stageRef.current = null;
    };
  }, []);

  // Rebuild the avatar when the recipe changes; a build that finishes after a newer one started is thrown away.
  const recipeKey = JSON.stringify(recipe);
  useEffect(() => {
    let stale = false;
    setBuilding(true);
    setBuildError(undefined);
    const r = JSON.parse(recipeKey) as AvatarRecipe;
    buildAvatar(r, manifest, (path) => packFileUrl(r.pack, path)).then(
      (avatar) => {
        const stage = stageRef.current;
        if (stale || !stage) {
          avatar.dispose();
          return;
        }
        stage.setAvatar(avatar);
        shownRef.current?.dispose();
        shownRef.current = avatar;
        setBuilding(false);
      },
      (err: unknown) => {
        if (stale) return;
        setBuildError(message(err));
        setBuilding(false);
      },
    );
    return () => {
      stale = true;
    };
  }, [recipeKey, manifest]);

  useEffect(() => {
    stageRef.current?.frameOn(focus ? groupCamera(manifest, focus) : undefined);
  }, [focus, manifest]);

  const edit = (change: () => void) => {
    setChoiceError(undefined);
    try {
      change();
    } catch (err) {
      setChoiceError(message(err));
    }
  };
  const pickPart = (group: string, id: string | null) =>
    edit(() => {
      const c = choosePart(recipe, manifest, group, id);
      setRecipe(c.recipe);
      setNotice(droppedText(c.dropped));
    });
  const pickTexture = (group: string, id: string | null) => edit(() => setRecipe(chooseTexture(recipe, manifest, group, id)));
  const pickColor = (group: string, hex: string | null) => edit(() => setRecipe(chooseColor(recipe, manifest, group, hex)));
  const pickPack = (p: AvatarPackInfo) =>
    edit(() => {
      if (p.name === recipe.pack) return;
      setRecipe(startingRecipe(p.name, p.manifest));
      setNotice(`Switched to ${p.title}: its parts start afresh.`);
      setFocus(undefined);
    });

  const problem = !name.trim() ? 'Give the avatar a name.' : buildError ? 'The avatar could not be built.' : building ? 'Wait for the avatar to load.' : undefined;
  const save = async () => {
    setSaveError(undefined);
    setSaving(true);
    try {
      const stage = stageRef.current;
      if (!stage) throw new Error('The 3D view is not ready.');
      const form = { name: name.trim(), recipe, singerId, portrait: stage.portrait() };
      if (existing) await avatarsApi.update(existing.id, form);
      else await avatarsApi.create(form);
      await queryClient.invalidateQueries({ queryKey: avatarsQueryKey });
      navigate('/avatars');
    } catch (err) {
      setSaveError(`Could not save the avatar: ${message(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const field = 'rounded-[8px] border border-line bg-[#141518] px-3 py-2 text-[14px] text-white outline-none focus:border-white/40';
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-[#1b1c1f] md:flex-row">
      <div className="relative h-[45vh] shrink-0 bg-[radial-gradient(ellipse_at_50%_40%,#3b3e4d,#16171b_70%)] md:h-auto md:min-w-0 md:flex-1">
        <canvas ref={canvasRef} className="block h-full w-full cursor-grab touch-none active:cursor-grabbing" aria-label="The avatar in 3D: drag to turn it" />
        {building ? <p className="pointer-events-none absolute left-4 top-4 rounded-full bg-black/50 px-3 py-1 text-[13px] text-white/80">Loading the parts…</p> : null}
        {buildError ? (
          <p className="absolute inset-x-4 top-4 rounded-[8px] bg-black/70 px-3 py-2 text-[13px] text-err" role="alert">
            The avatar could not be built: {buildError}
          </p>
        ) : null}
        <p className="pointer-events-none absolute bottom-3 left-0 right-0 text-center text-[12px] text-white/40">Drag to turn</p>
      </div>
      <aside className="flex min-h-0 w-full flex-col border-line md:w-[440px] md:border-l">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <h1 className="text-[20px] font-semibold">{existing ? `Dressing ${existing.name}` : 'New avatar'}</h1>
          <div className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-[13px] text-white/75" onFocus={() => setFocus('head')}>
              Name
              <input type="text" maxLength={60} value={name} className={field} placeholder="What the avatar is called" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-white/75">
              Voice
              <select className={field} value={singerId ?? ''} onChange={(e) => setSingerId(e.target.value === '' ? null : e.target.value)}>
                <option value="">No voice</option>
                {singers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.own ? ' (yours)' : ''}
                  </option>
                ))}
                {singerId !== null && !singers.some((s) => s.id === singerId) ? <option value={singerId}>A singer you no longer have ({singerId})</option> : null}
              </select>
            </label>
          </div>

          <Section title="Character" onFocus={() => setFocus(undefined)}>
            <div className="flex gap-2">
              {packs.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  aria-pressed={p.name === recipe.pack}
                  onClick={() => pickPack(p)}
                  className={`flex flex-1 items-center gap-2 rounded-[10px] border p-2 text-left text-[14px] ${p.name === recipe.pack ? 'border-white bg-white/10' : 'border-line hover:border-white/40'}`}
                >
                  <img src={p.thumbnailUrl} alt="" className="h-10 w-10 rounded-[6px] bg-black/30 object-cover" />
                  {p.title}
                </button>
              ))}
            </div>
          </Section>


          {orderedGroups(manifest).map((g) => (
            <GroupSection
              key={`${recipe.pack}/${g}`}
              pack={recipe.pack}
              manifest={manifest}
              group={g}
              recipe={recipe}
              onFocus={() => setFocus(g)}
              onPart={(id) => pickPart(g, id)}
              onTexture={(id) => pickTexture(g, id)}
              onColor={(hex) => pickColor(g, hex)}
            />
          ))}
        </div>
        <div className="flex flex-col gap-2 border-t border-line px-5 py-3">
          {notice ? (
            <p className="flex items-start gap-2 rounded-[8px] border border-white/15 bg-white/5 px-3 py-2 text-[13px] text-white/80" role="status">
              <span className="min-w-0 flex-1">{notice}</span>
              <button type="button" className="shrink-0 text-white/50 hover:text-white" aria-label="Dismiss" onClick={() => setNotice(undefined)}>
                ✕
              </button>
            </p>
          ) : null}
          {choiceError ? (
            <p className="text-[13px] text-err" role="alert">
              {choiceError}
            </p>
          ) : null}
          {saveError ? (
            <p className="text-[13px] text-err" role="alert">
              {saveError}
            </p>
          ) : null}
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={problem !== undefined || saving}
              className="rounded-full bg-white px-4 py-1.5 text-[14px] font-medium text-black disabled:opacity-40"
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="rounded-full border border-white/30 px-4 py-1.5 text-[14px] text-white/80 hover:border-white/60" onClick={() => navigate('/avatars')}>
              Cancel
            </button>
            {problem && !saving ? <span className="text-[12px] text-white/50">{problem}</span> : null}
          </div>
        </div>
      </aside>
    </main>
  );
}

function Section({ title, onFocus, children }: { title: string; onFocus: () => void; children: ReactNode }) {
  return (
    <section className="mt-6 flex flex-col gap-2" onPointerDown={onFocus} onFocus={onFocus} aria-label={title}>
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-white/55">{title}</h2>
      {children}
    </section>
  );
}

interface GroupSectionProps {
  readonly pack: string;
  readonly manifest: PackManifest;
  readonly group: string;
  readonly recipe: AvatarRecipe;
  readonly onFocus: () => void;
  readonly onPart: (id: string | null) => void;
  readonly onTexture: (id: string | null) => void;
  readonly onColor: (hex: string | null) => void;
}

/** One group: its parts (and "None" when it may be left out), then the chosen part's colourings and tints. */
export function GroupSection({ pack, manifest, group, recipe, onFocus, onPart, onTexture, onColor }: GroupSectionProps) {
  const g = packGroup(manifest, group)!;
  const chosenId = recipe.parts[group];
  const chosen: PackItem | undefined = chosenId ? packItem(manifest, group, chosenId) : undefined;
  const required = isRequired(manifest, group);
  // A group with one part that can't be left out (the body, the eyes) only offers that part's colourings.
  const showParts = !(required && g.collection.length === 1);
  const textures = useMemo(() => (chosen ? textureChoices(manifest, chosen) : []), [manifest, chosen]);
  const colors = useMemo(() => (chosen ? colorChoices(manifest, chosen) : []), [manifest, chosen]);
  const url = (path: string) => packFileUrl(pack, path);
  const tile = (on: boolean) => `relative overflow-hidden rounded-[8px] border bg-[#141518] ${on ? 'border-white ring-1 ring-white' : 'border-line hover:border-white/40'}`;
  return (
    <Section title={groupLabel(group)} onFocus={onFocus}>
      {showParts ? (
        <div className="grid grid-cols-5 gap-2">
          {required ? null : (
            <button type="button" aria-pressed={!chosen} title="None" className={`${tile(!chosen)} flex aspect-square items-center justify-center text-[12px] text-white/60`} onClick={() => onPart(null)}>
              None
            </button>
          )}
          {g.collection.map((item) => {
            const thumb = partThumbnail(item);
            return (
              <button key={item.id} type="button" aria-pressed={item.id === chosenId} title={item.name} className={`${tile(item.id === chosenId)} aspect-square`} onClick={() => onPart(item.id)}>
                {thumb ? <img src={url(thumb)} alt={item.name} loading="lazy" className="h-full w-full object-cover" /> : <span className="p-1 text-[11px] text-white/70">{item.name}</span>}
              </button>
            );
          })}
        </div>
      ) : null}
      {chosen && showParts ? <p className="text-[13px] text-white/70">{chosen.name}</p> : null}
      {textures.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label={`${groupLabel(group)}: colourings`}>
          {textures.map((t) => {
            const on = recipe.textures[group] === t.id;
            return (
              <button key={t.id} type="button" aria-pressed={on} title={t.name} className={`${tile(on)} h-11 w-11`} onClick={() => onTexture(on ? null : t.id)}>
                {t.thumbnail ? <img src={url(t.thumbnail)} alt={t.name} loading="lazy" className="h-full w-full object-cover" /> : <span className="text-[10px] text-white/70">{t.name}</span>}
              </button>
            );
          })}
        </div>
      ) : null}
      {colors.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label={`${groupLabel(group)}: colours`}>
          <button
            type="button"
            aria-pressed={recipe.colors[group] === undefined}
            title="Its own colour"
            className={`h-6 w-6 rounded-full border bg-[linear-gradient(135deg,#141518_45%,#e33_45%,#e33_55%,#141518_55%)] ${recipe.colors[group] === undefined ? 'border-white ring-1 ring-white' : 'border-white/30'}`}
            onClick={() => onColor(null)}
          />
          {colors.map((c) => {
            const on = recipe.colors[group]?.toLowerCase() === c.hex;
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                title={c.name}
                style={{ backgroundColor: c.hex }}
                className={`h-6 w-6 rounded-full border ${on ? 'border-white ring-2 ring-white' : 'border-black/40'}`}
                onClick={() => onColor(c.hex)}
              />
            );
          })}
        </div>
      ) : null}
    </Section>
  );
}
