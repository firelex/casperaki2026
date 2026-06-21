import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Loader2,
  Play,
  Square,
  cn,
} from '@teamsuzie/ui';
import { api, ApiError, type JobResult, type ReadyState, type ServiceStatus } from '../api.ts';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.serverMessage : String(err);
}

/** Read a File as raw base64 (strips the `data:...;base64,` prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** Read a File as UTF-8 text (used for the metadata JSON uploads). */
function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsText(file);
  });
}

const READY_BADGE: Record<ReadyState, { variant: 'default' | 'secondary' | 'outline' | 'destructive'; label: string }> = {
  ready: { variant: 'default', label: 'ready' },
  starting: { variant: 'secondary', label: 'starting' },
  stopped: { variant: 'outline', label: 'stopped' },
  error: { variant: 'destructive', label: 'error' },
};

/** Hugging Face repo a service's weights come from — shown when files are missing. */
const MODEL_REPO: Record<string, string> = {
  'ace-step': 'ACE-Step/Ace-Step1.5',
  'sam-audio': 'facebook/sam-audio-large',
  'soulx-singer': 'Soul-AILab/SoulX-Singer',
};

/** Per-service generation form, keyed by service id. */
const SERVICE_FORMS: Record<string, (props: { serviceId: string }) => ReactNode> = {
  'ace-step': MusicForm,
  'sam-audio': SamAudioForm,
  'soulx-singer': SoulXSingerForm,
  matchering: MatcheringForm,
};

export function StudioPage() {
  const qc = useQueryClient();
  const servicesQuery = useQuery({
    queryKey: ['services'],
    queryFn: api.services.list,
    // Poll quickly while anything is mid-startup so the badge flips to ready.
    refetchInterval: (q) => {
      const data = q.state.data as { services: ServiceStatus[] } | undefined;
      return data?.services.some((s) => s.readyState === 'starting') ? 2000 : 8000;
    },
  });
  const services = servicesQuery.data?.services ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['services'] });
  const models = services.filter((s) => s.category !== 'app');
  const apps = services.filter((s) => s.category === 'app');

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <header className="border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Studio</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Run your local models and audio apps as services and generate from them.
        </p>
      </header>

      {servicesQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading services…</div>
      ) : services.length === 0 ? (
        <div className="text-sm text-muted-foreground">No services configured.</div>
      ) : (
        <>
          <ServiceSection title="Models" services={models} onChanged={refresh} />
          <ServiceSection title="Apps" services={apps} onChanged={refresh} />
        </>
      )}
    </div>
  );
}

/** A labelled group of service panels (e.g. "Models", "Apps"); hidden if empty. */
function ServiceSection({ title, services, onChanged }: { title: string; services: ServiceStatus[]; onChanged: () => void }) {
  if (services.length === 0) return null;
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {services.map((service) => (
        <ServicePanel key={service.id} service={service} onChanged={onChanged} />
      ))}
    </section>
  );
}

/** Shared start/stop/status chrome; renders the model's own form when ready. */
function ServicePanel({ service, onChanged }: { service: ServiceStatus; onChanged: () => void }) {
  const badge = READY_BADGE[service.readyState];
  const start = useMutation({ mutationFn: () => api.services.start(service.id), onSuccess: onChanged });
  const stop = useMutation({ mutationFn: () => api.services.stop(service.id), onSuccess: onChanged });
  const busy = start.isPending || stop.isPending;
  const running = service.readyState === 'starting' || service.readyState === 'ready';
  const Form = SERVICE_FORMS[service.id];
  const repo = MODEL_REPO[service.id];
  // Apps have no weights; only models are blocked until their files are present.
  const missingModel = service.category === 'model' && !service.modelPath;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {service.label}
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </CardTitle>
            <CardDescription>{service.description}</CardDescription>
          </div>
          {running ? (
            <Button variant="outline" disabled={busy} onClick={() => stop.mutate()}
              className="border-destructive/30 text-destructive hover:bg-destructive/10">
              {stop.isPending ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
              Stop
            </Button>
          ) : (
            <Button disabled={busy || missingModel} onClick={() => start.mutate()}>
              {start.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Start
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {missingModel && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Model files not found. Download <span className="font-mono">{repo ?? service.label}</span> from the Models page first.
          </div>
        )}
        {service.readyState === 'error' && service.error && (
          <div className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {service.error}
            {service.logTail.length > 0 && <>{'\n\n'}{service.logTail.slice(-12).join('\n')}</>}
          </div>
        )}
        {service.readyState === 'starting' && (
          <div className="text-sm text-muted-foreground inline-flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Loading model… first start can take a minute.
          </div>
        )}
        {service.readyState === 'ready' && (Form
          ? <Form serviceId={service.id} />
          : <div className="text-sm text-muted-foreground">No form for this model yet.</div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Shared generation lifecycle: submit params, poll the job, expose state. Each
 * model's form builds its own param payload and calls `submit`.
 */
function useGeneration(serviceId: string) {
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<JobResult | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const generate = useMutation({
    mutationFn: (params: Record<string, unknown>) => api.services.generate(serviceId, params),
    onMutate: () => { setError(null); setResult(null); },
    onSuccess: (data) => setJobId(data.jobId),
    onError: (err) => setError(errorMessage(err)),
  });

  useEffect(() => {
    if (!jobId) return;
    const tick = async () => {
      try {
        const r = await api.services.result(serviceId, jobId);
        setResult(r);
        if (r.state !== 'running' && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch (err) {
        setError(errorMessage(err));
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId, serviceId]);

  const generating = generate.isPending || result?.state === 'running' || (!!jobId && !result);

  return {
    submit: (params: Record<string, unknown>) => generate.mutate(params),
    error, setError, result, jobId, generating,
  };
}

/** Renders a finished job's media + download link, plus error states. */
function GenerationResult(
  { serviceId, jobId, result, error }:
  { serviceId: string; jobId: string | null; result: JobResult | null; error: string | null },
) {
  return (
    <>
      {error && (
        <div className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {result?.state === 'error' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Generation failed: {result.error ?? 'unknown error'}
        </div>
      )}
      {result?.state === 'done' && jobId && (
        <div className="space-y-2">
          <div className="text-sm text-muted-foreground">Done.</div>
          {result.kind === 'video' ? (
            <video controls src={api.services.fileUrl(serviceId, jobId)} className={cn('w-full rounded-md')} />
          ) : result.kind === 'image' ? (
            <img alt="output" src={api.services.fileUrl(serviceId, jobId)} className={cn('w-full rounded-md')} />
          ) : (
            <audio controls src={api.services.fileUrl(serviceId, jobId)} className={cn('w-full')} />
          )}
          <a href={api.services.fileUrl(serviceId, jobId)} download className="text-xs text-primary underline">
            Download
          </a>
        </div>
      )}
    </>
  );
}

const FIELD_LABEL = 'text-xs font-medium uppercase text-muted-foreground';
const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

function MusicForm({ serviceId }: { serviceId: string }) {
  const [prompt, setPrompt] = useState('upbeat synthwave, driving bassline, 120 bpm');
  const [lyrics, setLyrics] = useState('');
  const [duration, setDuration] = useState('30');
  const [refFile, setRefFile] = useState<File | null>(null);
  const [refMode, setRefMode] = useState<'style' | 'remix'>('style');
  const [strength, setStrength] = useState('0.5');
  const { submit, generating, error, setError, result, jobId } = useGeneration(serviceId);

  // Build the param payload, base64-ing the optional reference track, then fire.
  async function onSubmit() {
    try {
      const params: Record<string, unknown> = { prompt, lyrics: lyrics.trim() || undefined };
      // A remix locks output length to the source, so don't send a duration.
      if (!(refFile && refMode === 'remix')) params.audio_duration = Number(duration) || undefined;
      if (refFile) {
        params.reference_audio = await fileToBase64(refFile);
        params.reference_filename = refFile.name;
        params.reference_mode = refMode;
        if (refMode === 'style') params.style_strength = Number(strength);
      }
      submit(params);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form className="space-y-3 border-t border-border pt-4" onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}>
      <div className="space-y-1">
        <label className={FIELD_LABEL}>Prompt / style</label>
        <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="genre, mood, tempo…" />
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <div className="space-y-1">
          <label className={FIELD_LABEL}>Lyrics (optional)</label>
          <textarea value={lyrics} onChange={(e) => setLyrics(e.target.value)} rows={3} placeholder="[verse]…" className={TEXTAREA_CLASS} />
        </div>
        <div className="space-y-1">
          <label className={FIELD_LABEL}>Duration (s)</label>
          <Input type="number" min={5} max={600} value={duration} disabled={!!refFile && refMode === 'remix'} onChange={(e) => setDuration(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between">
          <label className={FIELD_LABEL}>Reference track (optional)</label>
          {refFile && (
            <button type="button" onClick={() => setRefFile(null)} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
              clear
            </button>
          )}
        </div>
        <input type="file" accept="audio/*" onChange={(e) => setRefFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent" />
        {refFile && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Button type="button" size="sm" variant={refMode === 'style' ? 'default' : 'outline'} onClick={() => setRefMode('style')}>
                Style reference
              </Button>
              <Button type="button" size="sm" variant={refMode === 'remix' ? 'default' : 'outline'} onClick={() => setRefMode('remix')}>
                Remix track
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {refMode === 'style'
                ? 'Generate new music in this track’s style, steered by your prompt & lyrics.'
                : 'Re-render the uploaded track itself — output length follows the source.'}
            </p>
            {refMode === 'style' && (
              <div className="space-y-1">
                <label className={FIELD_LABEL}>Style strength · {strength}</label>
                <input type="range" min={0} max={1} step={0.05} value={strength} onChange={(e) => setStrength(e.target.value)} className="w-full" />
                <div className="flex justify-between text-[10px] uppercase text-muted-foreground">
                  <span>subtle</span>
                  <span>strong</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <Button type="submit" disabled={generating || (!prompt.trim() && !refFile)}>
        {generating ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        {generating ? 'Generating…' : refFile ? (refMode === 'remix' ? 'Remix track' : 'Generate with reference') : 'Generate music'}
      </Button>

      <GenerationResult serviceId={serviceId} jobId={jobId} result={result} error={error} />
    </form>
  );
}

function SamAudioForm({ serviceId }: { serviceId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState('a man speaking');
  const [predictSpans, setPredictSpans] = useState(false);
  const [rerank, setRerank] = useState(false);
  const [output, setOutput] = useState<'target' | 'residual'>('target');
  const { submit, generating, error, setError, result, jobId } = useGeneration(serviceId);

  async function onSubmit() {
    try {
      if (!file) { setError('Upload an audio file to separate.'); return; }
      submit({
        audio: await fileToBase64(file),
        audio_filename: file.name,
        description,
        predict_spans: predictSpans,
        // 8 candidates is the upstream "better but slower" setting; 1 = off.
        reranking_candidates: rerank ? 8 : 1,
        output,
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form className="space-y-3 border-t border-border pt-4" onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}>
      <div className="space-y-1">
        <label className={FIELD_LABEL}>Input audio</label>
        <input type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent" />
      </div>
      <div className="space-y-1">
        <label className={FIELD_LABEL}>Sound to isolate</label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="lowercase phrase, e.g. “dog barking”" />
        <p className="text-[11px] text-muted-foreground">Use a lowercase noun/verb phrase to match how the model was trained.</p>
      </div>
      <div className="space-y-1">
        <label className={FIELD_LABEL}>Output</label>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant={output === 'target' ? 'default' : 'outline'} onClick={() => setOutput('target')}>
            Isolated sound
          </Button>
          <Button type="button" size="sm" variant={output === 'residual' ? 'default' : 'outline'} onClick={() => setOutput('residual')}>
            Everything else
          </Button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input type="checkbox" checked={predictSpans} onChange={(e) => setPredictSpans(e.target.checked)} />
        Predict spans (better for discrete events, slower)
      </label>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} />
        Re-rank 8 candidates (best quality, much slower)
      </label>

      <Button type="submit" disabled={generating || !file}>
        {generating ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        {generating ? 'Separating…' : 'Separate'}
      </Button>

      <GenerationResult serviceId={serviceId} jobId={jobId} result={result} error={error} />
    </form>
  );
}

function SoulXSingerForm({ serviceId }: { serviceId: string }) {
  const [promptAudio, setPromptAudio] = useState<File | null>(null);
  const [promptMeta, setPromptMeta] = useState<File | null>(null);
  const [targetMeta, setTargetMeta] = useState<File | null>(null);
  const [control, setControl] = useState<'melody' | 'score'>('melody');
  const [autoShift, setAutoShift] = useState(false);
  const [pitchShift, setPitchShift] = useState('0');
  const { submit, generating, error, setError, result, jobId } = useGeneration(serviceId);

  async function onSubmit() {
    try {
      if (!promptAudio || !promptMeta || !targetMeta) {
        setError('Provide the reference clip plus both metadata JSON files.');
        return;
      }
      submit({
        prompt_audio: await fileToBase64(promptAudio),
        prompt_filename: promptAudio.name,
        prompt_metadata: await fileToText(promptMeta),
        target_metadata: await fileToText(targetMeta),
        control,
        auto_shift: autoShift,
        pitch_shift: Number(pitchShift) || 0,
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const fileInput = (accept: string, onChange: (f: File | null) => void) => (
    <input type="file" accept={accept} onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent" />
  );

  return (
    <form className="space-y-3 border-t border-border pt-4" onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}>
      <p className="text-[11px] text-muted-foreground">
        Singing is rendered from a reference voice and a preprocessed score. The metadata JSONs (phonemes, notes, F0)
        come from the SoulX-Singer preprocessing pipeline.
      </p>
      <div className="space-y-1">
        <label className={FIELD_LABEL}>Reference voice clip</label>
        {fileInput('audio/*', setPromptAudio)}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={FIELD_LABEL}>Prompt metadata (JSON)</label>
          {fileInput('application/json,.json', setPromptMeta)}
        </div>
        <div className="space-y-1">
          <label className={FIELD_LABEL}>Target score (JSON)</label>
          {fileInput('application/json,.json', setTargetMeta)}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <div className="space-y-1">
          <label className={FIELD_LABEL}>Pitch control</label>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={control === 'melody' ? 'default' : 'outline'} onClick={() => setControl('melody')}>
              Melody (F0)
            </Button>
            <Button type="button" size="sm" variant={control === 'score' ? 'default' : 'outline'} onClick={() => setControl('score')}>
              Score (MIDI)
            </Button>
          </div>
        </div>
        <div className="space-y-1">
          <label className={FIELD_LABEL}>Pitch shift</label>
          <Input type="number" min={-12} max={12} value={pitchShift} onChange={(e) => setPitchShift(e.target.value)} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input type="checkbox" checked={autoShift} onChange={(e) => setAutoShift(e.target.checked)} />
        Auto pitch shift to fit the reference voice
      </label>

      <Button type="submit" disabled={generating || !promptAudio || !promptMeta || !targetMeta}>
        {generating ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        {generating ? 'Synthesizing…' : 'Synthesize singing'}
      </Button>

      <GenerationResult serviceId={serviceId} jobId={jobId} result={result} error={error} />
    </form>
  );
}

function MatcheringForm({ serviceId }: { serviceId: string }) {
  const [target, setTarget] = useState<File | null>(null);
  const [reference, setReference] = useState<File | null>(null);
  const [bitDepth, setBitDepth] = useState<16 | 24>(16);
  const { submit, generating, error, setError, result, jobId } = useGeneration(serviceId);

  async function onSubmit() {
    try {
      if (!target || !reference) { setError('Upload both a target track and a reference track.'); return; }
      submit({
        target_audio: await fileToBase64(target),
        target_filename: target.name,
        reference_audio: await fileToBase64(reference),
        reference_filename: reference.name,
        bit_depth: bitDepth,
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form className="space-y-3 border-t border-border pt-4" onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}>
      <p className="text-[11px] text-muted-foreground">
        Masters the <strong>target</strong> track to match the <strong>reference</strong> track’s loudness, tonal balance and dynamics.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={FIELD_LABEL}>Target (track to master)</label>
          <input type="file" accept="audio/*" onChange={(e) => setTarget(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent" />
        </div>
        <div className="space-y-1">
          <label className={FIELD_LABEL}>Reference (sound to match)</label>
          <input type="file" accept="audio/*" onChange={(e) => setReference(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent" />
        </div>
      </div>
      <div className="space-y-1">
        <label className={FIELD_LABEL}>Output bit depth</label>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant={bitDepth === 16 ? 'default' : 'outline'} onClick={() => setBitDepth(16)}>
            16-bit WAV
          </Button>
          <Button type="button" size="sm" variant={bitDepth === 24 ? 'default' : 'outline'} onClick={() => setBitDepth(24)}>
            24-bit WAV
          </Button>
        </div>
      </div>

      <Button type="submit" disabled={generating || !target || !reference}>
        {generating ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        {generating ? 'Mastering…' : 'Master to reference'}
      </Button>

      <GenerationResult serviceId={serviceId} jobId={jobId} result={result} error={error} />
    </form>
  );
}
