import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { buildVrmAvatar, type Avatar } from '@casperaki/video/avatar';

import { avatarsApi, avatarsQueryKey, realisticLibraryQueryKey, type AvatarInfo } from '../api/avatars';
import { singersApi, singersQueryKey, type SingerInfo } from '../api/singers';
import { AvatarStage } from '../avatars/AvatarStage';
import {
  ANCESTRY_LABELS,
  chooseGarment,
  defaultDesign,
  FACE_LABELS,
  FACE_SLIDERS,
  garmentIn,
  garmentsFor,
  setAncestry,
  SLOT_LABELS,
  SLOTS,
  type Ancestry,
  type RealisticDesign,
  type RealisticLibraryInfo,
} from '../avatars/realisticDesign';
import { AppHeader } from '../layout/AppHeader';
import { useTasks } from '../state/tasks';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The realistic dressing room (admins; docs/superpowers/specs/2026-11-28-realistic-avatars-design.md): a MakeHuman
 * person designed with sliders and choices on the right, built on the server ("Update", about 10 s) and shown in 3D on
 * the left exactly as the videos will show it. Save keeps the latest build of the current design, with a name and a
 * voice. /avatars/realistic/new or /avatars/realistic/:id.
 */
export function RealisticDressingRoomPage() {
  const { avatarId } = useParams<{ avatarId: string }>();
  const library = useQuery({ queryKey: realisticLibraryQueryKey, queryFn: ({ signal }) => avatarsApi.realisticLibrary(signal), staleTime: Infinity });
  const avatars = useQuery({ queryKey: avatarsQueryKey, queryFn: ({ signal }) => avatarsApi.list(signal), enabled: avatarId !== undefined });
  const singers = useQuery({ queryKey: singersQueryKey, queryFn: ({ signal }) => singersApi.list(signal), staleTime: 60_000 });

  let body: ReactNode;
  const failed = [
    library.isError ? `The realistic library could not be loaded: ${message(library.error)}` : undefined,
    avatars.isError ? `Your avatars could not be loaded: ${message(avatars.error)}` : undefined,
    singers.isError ? `The singers could not be loaded: ${message(singers.error)}` : undefined,
  ].filter((x): x is string => x !== undefined);
  const existing = avatarId !== undefined ? avatars.data?.avatars.find((a) => a.id === avatarId) : undefined;
  if (failed.length > 0) {
    body = (
      <p className="p-6 text-[14px] text-err" role="alert">
        {failed.join(' ')}
      </p>
    );
  } else if (!library.data || !singers.data || (avatarId !== undefined && !avatars.data)) {
    body = <p className="p-6 text-[14px] text-white/55">Loading…</p>;
  } else if (avatarId !== undefined && (!existing || existing.style !== 'realistic')) {
    body = (
      <p className="p-6 text-[14px] text-err" role="alert">
        You have no realistic avatar “{avatarId}”.
      </p>
    );
  } else {
    body = <Room key={avatarId ?? 'new'} library={library.data.library} singers={singers.data.singers} existing={existing} />;
  }
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-white">
      <AppHeader />
      {body}
    </div>
  );
}

function Room({ library, singers, existing }: { library: RealisticLibraryInfo; singers: readonly SingerInfo[]; existing: AvatarInfo | undefined }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [design, setDesign] = useState<RealisticDesign>(() => existing?.design ?? defaultDesign(library));
  const [name, setName] = useState(existing?.name ?? '');
  const [singerId, setSingerId] = useState<string | null>(existing?.singerId ?? null);
  /** The build started for a design (its key): the task id. */
  const [build, setBuild] = useState<{ taskId: string; key: string } | undefined>(undefined);
  const [startError, setStartError] = useState<string | undefined>(undefined);
  const [showError, setShowError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [shownKey, setShownKey] = useState<string | undefined>(undefined);
  const { data: tasks } = useTasks();
  const task = build ? (tasks ?? []).find((t) => t.id === build.taskId) : undefined;
  const designKey = JSON.stringify(design);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<AvatarStage | null>(null);
  const shownRef = useRef<Avatar | null>(null);
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

  // What the 3D view shows: the latest finished build, else the saved avatar's person.
  const showUrl = task?.state === 'done' && build ? avatarsApi.buildVrmUrl(build.taskId) : existing?.vrmUrl;
  const showKey = task?.state === 'done' && build ? build.key : existing ? JSON.stringify(existing.design) : undefined;
  useEffect(() => {
    if (!showUrl) return;
    let stale = false;
    setShowError(undefined);
    buildVrmAvatar(showUrl, 'the built person').then(
      (avatar) => {
        const stage = stageRef.current;
        if (stale || !stage) {
          avatar.dispose();
          return;
        }
        stage.setAvatar(avatar);
        shownRef.current?.dispose();
        shownRef.current = avatar;
        setShownKey(showKey);
      },
      (err: unknown) => {
        if (!stale) setShowError(message(err));
      },
    );
    return () => {
      stale = true;
    };
  }, [showUrl, showKey]);

  const update = async () => {
    setStartError(undefined);
    try {
      const { task: t } = await avatarsApi.build(design);
      setBuild({ taskId: t.id, key: designKey });
    } catch (err) {
      setStartError(message(err));
    }
  };
  const building = task?.state === 'running';
  const builtCurrent = task?.state === 'done' && build?.key === designKey;

  const problem = !name.trim()
    ? 'Give the avatar a name.'
    : building
      ? 'Wait for the build.'
      : !builtCurrent
        ? 'Press Update to build this design first.'
        : shownKey !== designKey
          ? 'Wait for the person to load.'
          : undefined;
  const save = async () => {
    setSaveError(undefined);
    setSaving(true);
    try {
      const stage = stageRef.current;
      if (!stage || !build) throw new Error('The 3D view is not ready.');
      const form = { name: name.trim(), singerId, buildTaskId: build.taskId, portrait: stage.portrait() };
      if (existing) await avatarsApi.updateRealistic(existing.id, form);
      else await avatarsApi.createRealistic(form);
      await queryClient.invalidateQueries({ queryKey: avatarsQueryKey });
      navigate('/avatars');
    } catch (err) {
      setSaveError(`Could not save the avatar: ${message(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const set = (change: Partial<RealisticDesign>) => setDesign((d) => ({ ...d, ...change }));
  const hair = library.hair.find((h) => h.id === design.hair);
  const credits = useMemo(() => creditsOf(design, library), [design, library]);
  const field = 'rounded-[8px] border border-line bg-[#141518] px-3 py-2 text-[14px] text-white outline-none focus:border-white/40';

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-[#1b1c1f] md:flex-row">
      <div className="relative h-[45vh] shrink-0 bg-[radial-gradient(ellipse_at_50%_40%,#3b3e4d,#16171b_70%)] md:h-auto md:min-w-0 md:flex-1">
        <canvas ref={canvasRef} className="block h-full w-full cursor-grab touch-none active:cursor-grabbing" aria-label="The avatar in 3D: drag to turn it" />
        {!showUrl && !building ? (
          <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-[14px] text-white/60">Choose a look, then press Update to see the person.</p>
        ) : null}
        {building ? <p className="pointer-events-none absolute left-4 top-4 rounded-full bg-black/50 px-3 py-1 text-[13px] text-white/80">Building the person…</p> : null}
        {task?.state === 'failed' ? (
          <p className="absolute inset-x-4 top-4 rounded-[8px] bg-black/70 px-3 py-2 text-[13px] text-err" role="alert">
            The build failed: {task.message ?? 'no reason given'}
          </p>
        ) : null}
        {showError ? (
          <p className="absolute inset-x-4 top-4 rounded-[8px] bg-black/70 px-3 py-2 text-[13px] text-err" role="alert">
            The person could not be shown: {showError}
          </p>
        ) : null}
        {shownKey !== undefined && shownKey !== designKey && !building ? (
          <p className="pointer-events-none absolute bottom-10 left-0 right-0 text-center text-[13px] text-white/70">You changed the design: press Update to see it.</p>
        ) : null}
        <p className="pointer-events-none absolute bottom-3 left-0 right-0 text-center text-[12px] text-white/40">Drag to turn</p>
      </div>
      <aside className="flex min-h-0 w-full flex-col border-line md:w-[440px] md:border-l">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <h1 className="text-[20px] font-semibold">{existing ? `Dressing ${existing.name}` : 'New realistic avatar'}</h1>
          <div className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-[13px] text-white/75">
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

          <Section title="Body">
            <Slider label="Woman ↔ man" value={design.body.gender} min={0} max={1} onChange={(v) => set({ body: { ...design.body, gender: v } })} />
            <Slider label={`Age: ${Math.round(design.body.age)}`} value={design.body.age} min={18} max={90} step={1} onChange={(v) => set({ body: { ...design.body, age: v } })} />
            <Slider label="Weight" value={design.body.weight} min={0} max={1} onChange={(v) => set({ body: { ...design.body, weight: v } })} />
            <Slider label="Muscle" value={design.body.muscle} min={0} max={1} onChange={(v) => set({ body: { ...design.body, muscle: v } })} />
            <Slider label="Proportions" value={design.body.proportions} min={0} max={1} onChange={(v) => set({ body: { ...design.body, proportions: v } })} />
          </Section>

          <Section title="Ancestry">
            {(Object.keys(ANCESTRY_LABELS) as (keyof Ancestry)[]).map((k) => (
              <Slider key={k} label={`${ANCESTRY_LABELS[k]}: ${Math.round(design.ancestry[k] * 100)}%`} value={design.ancestry[k]} min={0} max={1} onChange={(v) => set({ ancestry: setAncestry(design.ancestry, k, v) })} />
            ))}
          </Section>

          <Section title="Face">
            {FACE_SLIDERS.map((k) => {
              const [label, low, high] = FACE_LABELS[k];
              return <Slider key={k} label={label} hint={`${low} ↔ ${high}`} value={design.face[k]} min={-1} max={1} onChange={(v) => set({ face: { ...design.face, [k]: v } })} />;
            })}
          </Section>

          <Section title="Skin and eyes">
            <Choice label="Skin" value={design.skin} options={library.skins} onChange={(v) => set({ skin: v! })} />
            <Choice label="Eyes" value={design.eyes} options={library.eyes} onChange={(v) => set({ eyes: v! })} />
            <Choice label="Eyebrows" value={design.eyebrows} options={library.eyebrows} onChange={(v) => set({ eyebrows: v! })} />
            <Tint label="Lip colour" value={design.lips} fallback="#9E0F1A" onChange={(v) => set({ lips: v })} />
          </Section>

          <Section title="Hair">
            <Choice label="Style" value={design.hair} options={library.hair} onChange={(v) => set({ hair: v!, hairColour: null })} />
            {hair && hair.colours.length > 0 ? <Choice label="Colour" value={design.hairColour} options={hair.colours} none="Its own colour" onChange={(v) => set({ hairColour: v })} /> : null}
            <Tint label="Tint" value={design.hairTint} fallback="#3B2A1E" onChange={(v) => set({ hairTint: v })} />
          </Section>

          <Section title="Clothes">
            {SLOTS.map((slot) => (
              <Choice
                key={slot}
                label={SLOT_LABELS[slot]}
                value={garmentIn(design.clothes, library, slot) ?? null}
                options={garmentsFor(library, slot)}
                none="None"
                extra={(() => {
                  const g = garmentIn(design.clothes, library, slot);
                  const entry = g ? library.clothes.find((c) => c.id === g) : undefined;
                  return entry && entry.slot !== slot ? entry : undefined;
                })()}
                onChange={(v) => set({ clothes: chooseGarment(design.clothes, library, slot, v) })}
              />
            ))}
          </Section>

          {credits.length > 0 ? (
            <p className="mt-6 text-[12px] text-white/45">
              Credits (CC-BY): {credits.join('; ')}. Made with MakeHuman.
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 border-t border-line px-5 py-3">
          {startError ? (
            <p className="text-[13px] text-err" role="alert">
              Could not start the build: {startError}
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
              disabled={building}
              className="rounded-full border border-white/60 px-4 py-1.5 text-[14px] text-white hover:border-white disabled:opacity-40"
              onClick={() => void update()}
            >
              {building ? 'Building…' : 'Update'}
            </button>
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
          </div>
          {problem && !saving ? <span className="text-[12px] text-white/50">{problem}</span> : null}
        </div>
      </aside>
    </main>
  );
}

/** The CC-BY credits of the assets a design uses. */
function creditsOf(design: RealisticDesign, lib: RealisticLibraryInfo): string[] {
  const hair = lib.hair.find((h) => h.id === design.hair);
  const used = [
    lib.skins.find((x) => x.id === design.skin),
    lib.eyes.find((x) => x.id === design.eyes),
    lib.eyebrows.find((x) => x.id === design.eyebrows),
    hair,
    hair?.colours.find((c) => c.id === design.hairColour),
    ...design.clothes.map((c) => lib.clothes.find((x) => x.id === c)),
  ];
  const out: string[] = [];
  for (const e of used) {
    if (!e || e.licence !== 'CC-BY') continue;
    const line = [`${e.name} by ${e.author}`, ...(e.credit ?? [])].join(', ');
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 flex flex-col gap-3" aria-label={title}>
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-white/55">{title}</h2>
      {children}
    </section>
  );
}

function Slider({ label, hint, value, min, max, step = 0.01, onChange }: { label: string; hint?: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-[13px] text-white/75">
      <span className="flex justify-between gap-2">
        <span>{label}</span>
        {hint ? <span className="text-white/40">{hint}</span> : null}
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-white" />
    </label>
  );
}

function Choice({
  label,
  value,
  options,
  none,
  extra,
  onChange,
}: {
  label: string;
  value: string | null;
  options: readonly { id: string; name: string; licence: string }[];
  none?: string;
  /** A garment filed under another slot that covers this one (a suit's trousers, a dress's top). */
  extra?: { id: string; name: string } | undefined;
  onChange: (v: string | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[13px] text-white/75">
      {label}
      <select
        className="rounded-[8px] border border-line bg-[#141518] px-3 py-2 text-[14px] text-white outline-none focus:border-white/40"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        {none !== undefined ? <option value="">{none}</option> : null}
        {extra ? <option value={extra.id}>{`${extra.name} (covers it)`}</option> : null}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
            {o.licence === 'CC-BY' ? ' · CC-BY' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

function Tint({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (v: string | null) => void }) {
  return (
    <div className="flex items-center gap-3 text-[13px] text-white/75">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={value !== null} onChange={(e) => onChange(e.target.checked ? fallback : null)} />
        {label}
      </label>
      {value !== null ? <input type="color" value={value} aria-label={`${label} colour`} onChange={(e) => onChange(e.target.value.toUpperCase())} /> : null}
    </div>
  );
}
