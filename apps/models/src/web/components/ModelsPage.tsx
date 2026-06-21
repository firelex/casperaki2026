import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  Input,
  LoadingState,
  cn,
  useConfirm,
  Check,
  Download,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Square,
  Trash2,
  XCircle,
} from '@teamsuzie/ui';
import {
  api,
  ApiError,
  type DownloadJob,
  type HuggingFaceModel,
  type LocalModel,
  type ReadyState,
  type ServiceStatus,
} from '../api.ts';

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 2 : 1)} ${units[index]}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.serverMessage : String(err);
}

const FORMAT_VARIANT: Record<LocalModel['format'], 'default' | 'secondary' | 'outline'> = {
  safetensors: 'default',
  pytorch: 'secondary',
  gguf: 'outline',
  other: 'outline',
};

const READY_BADGE: Record<ReadyState, { variant: 'default' | 'secondary' | 'outline' | 'destructive'; label: string }> = {
  ready: { variant: 'default', label: 'running' },
  starting: { variant: 'secondary', label: 'starting' },
  stopped: { variant: 'outline', label: 'stopped' },
  error: { variant: 'destructive', label: 'error' },
};

export function ModelsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [repoId, setRepoId] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: api.models.list,
    refetchInterval: 10000,
  });
  const downloadsQuery = useQuery({
    queryKey: ['model-downloads'],
    queryFn: api.models.listDownloads,
    refetchInterval: (q) => {
      const data = q.state.data as { downloads: DownloadJob[] } | undefined;
      return data?.downloads.some((d) => d.state === 'active') ? 1000 : 5000;
    },
  });
  const inspectQuery = useQuery({
    queryKey: ['hf-model', selectedRepo],
    queryFn: () => api.models.huggingFaceModel(selectedRepo!),
    enabled: !!selectedRepo && inspectOpen,
  });
  const servicesQuery = useQuery({
    queryKey: ['services'],
    queryFn: api.services.list,
    // Poll quickly while anything is mid-startup so the badge flips to running.
    refetchInterval: (q) => {
      const data = q.state.data as { services: ServiceStatus[] } | undefined;
      return data?.services.some((s) => s.readyState === 'starting') ? 2000 : 8000;
    },
  });

  const download = useMutation({
    mutationFn: (repo: string) => api.models.download(repo),
    onSuccess: () => {
      setError(null);
      setInspectOpen(false);
      qc.invalidateQueries({ queryKey: ['model-downloads'] });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: api.models.delete,
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['models'] });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const models = modelsQuery.data?.models ?? [];
  const downloads = downloadsQuery.data?.downloads ?? [];
  const totalSize = useMemo(() => models.reduce((sum, m) => sum + m.sizeBytes, 0), [models]);

  const activeRepos = useMemo(() => {
    const set = new Set<string>();
    for (const d of downloads) if (d.state === 'active') set.add(d.repoId);
    return set;
  }, [downloads]);

  // A model row maps to a service when the service serves that on-disk folder.
  const serviceByPath = useMemo(() => {
    const map = new Map<string, ServiceStatus>();
    for (const s of servicesQuery.data?.services ?? []) {
      if (s.modelPath) map.set(s.modelPath, s);
    }
    return map;
  }, [servicesQuery.data]);

  function startInspect() {
    const id = repoId.trim();
    if (!id) return;
    setSelectedRepo(id);
    setInspectOpen(true);
    setError(null);
  }

  async function confirmDelete(model: LocalModel) {
    const ok = await confirm({
      title: 'Delete model',
      description: (
        <>
          <span className="block">Permanently delete <span className="font-semibold">{model.name}</span> from disk?</span>
          <span className="mt-2 block break-all font-mono text-xs">{model.path}</span>
          <span className="mt-2 block text-xs">{formatBytes(model.sizeBytes)} will be freed. This can't be undone.</span>
        </>
      ),
      variant: 'destructive',
      confirmLabel: 'Delete',
    });
    if (ok) remove.mutate(model.path);
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Download full-precision CUDA models from Hugging Face (safetensors / PyTorch weights — not GGUF quants) and manage local checkouts.
          </p>
        </div>
        <Button variant="outline" onClick={() => modelsQuery.refetch()} disabled={modelsQuery.isFetching}>
          <RefreshCw className={cn('size-4', modelsQuery.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      <section className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a model from Hugging Face</CardTitle>
            <CardDescription>
              Paste a repo id like <span className="font-mono">Qwen/Qwen2.5-7B-Instruct</span>. Downloads land in{' '}
              <span className="font-mono">{modelsQuery.data?.downloadDir ?? '~/models'}</span>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]"
              onSubmit={(e) => { e.preventDefault(); startInspect(); }}
            >
              <Input
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
                placeholder="owner/model"
                autoFocus
              />
              <Button disabled={!repoId.trim()}>
                <Search className="size-4" />
                Inspect
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription className="uppercase tracking-wide text-xs">Inventory</CardDescription>
            <CardTitle className="text-3xl">{models.length}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground">{formatBytes(totalSize)} on disk</div>
          </CardContent>
        </Card>
      </section>

      {error && (
        <div className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {downloads.length > 0 && (
        <section className="overflow-hidden rounded-md border border-border bg-card">
          <div className="border-b border-border bg-muted/50 px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
            Downloads
          </div>
          <ul className="divide-y divide-border">
            {downloads.map((d) => <DownloadRow key={d.id} job={d} />)}
          </ul>
        </section>
      )}

      <section className="overflow-hidden rounded-md border border-border bg-card">
        <div className="grid grid-cols-[minmax(0,1fr)_7rem_5.5rem_9rem_10rem_3rem] border-b border-border bg-muted/50 px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
          <div>Name</div>
          <div>Format</div>
          <div>Size</div>
          <div>Modified</div>
          <div>Status</div>
          <div />
        </div>
        {modelsQuery.isLoading ? (
          <div className="px-4 py-8"><LoadingState>Loading models…</LoadingState></div>
        ) : models.length === 0 ? (
          <EmptyState className="py-12">
            <EmptyStateIcon><FileText className="size-6" /></EmptyStateIcon>
            <EmptyStateTitle>No models yet</EmptyStateTitle>
            <EmptyStateDescription>Inspect a Hugging Face repo above to download your first CUDA model.</EmptyStateDescription>
          </EmptyState>
        ) : models.map((model) => (
          <div
            key={model.id}
            className="grid grid-cols-[minmax(0,1fr)_7rem_5.5rem_9rem_10rem_3rem] items-center gap-2 border-b border-border px-4 py-3 last:border-0"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{model.name}</div>
              <div className="truncate font-mono text-xs text-muted-foreground" title={model.path}>
                {model.path} · {model.fileCount} files
              </div>
            </div>
            <div><Badge variant={FORMAT_VARIANT[model.format]}>{model.format}</Badge></div>
            <div className="text-sm text-muted-foreground">{formatBytes(model.sizeBytes)}</div>
            <div className="text-sm text-muted-foreground">{formatDate(model.modified)}</div>
            <div className="min-w-0">
              <ServiceControl service={serviceByPath.get(model.path)} onChanged={() => qc.invalidateQueries({ queryKey: ['services'] })} />
            </div>
            <div className="flex justify-end">
              <Button
                size="icon"
                variant="outline"
                title={`Delete ${model.name}`}
                aria-label={`Delete ${model.name}`}
                className="border-destructive/30 text-destructive hover:bg-destructive/10"
                disabled={remove.isPending}
                onClick={() => confirmDelete(model)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </section>

      <section className="rounded-md border border-border bg-card p-4">
        <div className="text-xs font-medium uppercase text-muted-foreground">Scanned folders</div>
        <div className="mt-2 grid gap-1">
          {(modelsQuery.data?.roots ?? []).map((root) => (
            <div key={root} className="truncate font-mono text-xs text-muted-foreground">{root}</div>
          ))}
        </div>
      </section>

      <Dialog open={inspectOpen} onOpenChange={setInspectOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{selectedRepo ?? 'Model'}</DialogTitle>
            <DialogDescription>
              Full-precision files we'll download (GGUF quants are skipped).
            </DialogDescription>
          </DialogHeader>
          {inspectQuery.isLoading ? (
            <div className="p-4"><LoadingState>Reading repo…</LoadingState></div>
          ) : inspectQuery.isError ? (
            <div className="p-4 text-sm text-destructive">{errorMessage(inspectQuery.error)}</div>
          ) : inspectQuery.data ? (
            <InspectBody model={inspectQuery.data} />
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setInspectOpen(false)}>Cancel</Button>
            <Button
              disabled={
                !inspectQuery.data ||
                inspectQuery.data.ggufOnly ||
                inspectQuery.data.files.length === 0 ||
                (selectedRepo ? activeRepos.has(selectedRepo) : false) ||
                download.isPending
              }
              onClick={() => selectedRepo && download.mutate(selectedRepo)}
            >
              {download.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              Download full model{inspectQuery.data ? ` · ${formatBytes(inspectQuery.data.totalBytes)}` : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InspectBody({ model }: { model: HuggingFaceModel }) {
  if (model.ggufOnly) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
        {model.repoId} only ships GGUF quants. This app downloads full CUDA weights — pick a repo that publishes safetensors / PyTorch files.
      </div>
    );
  }
  return (
    <div className="max-h-[26rem] overflow-auto rounded-md border border-border">
      {model.files.map((file) => (
        <div key={file.path} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-0">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-xs">{file.path}</div>
          </div>
          {file.isWeight && <Badge variant="default">weight</Badge>}
          <div className="w-20 text-right text-xs text-muted-foreground">{formatBytes(file.sizeBytes)}</div>
        </div>
      ))}
    </div>
  );
}

/** Lifecycle badge + Start/Stop for a model that's wired to a serving adapter. */
function ServiceControl({ service, onChanged }: { service: ServiceStatus | undefined; onChanged: () => void }) {
  const start = useMutation({ mutationFn: () => api.services.start(service!.id), onSuccess: onChanged });
  const stop = useMutation({ mutationFn: () => api.services.stop(service!.id), onSuccess: onChanged });

  // Not a servable model (no adapter targets this folder).
  if (!service) return <span className="text-xs text-muted-foreground">—</span>;

  const badge = READY_BADGE[service.readyState];
  const busy = start.isPending || stop.isPending;
  const running = service.readyState === 'starting' || service.readyState === 'ready';

  return (
    <div className="flex items-center gap-2">
      <Badge variant={badge.variant}>{badge.label}</Badge>
      {running ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => stop.mutate()}
          title="Stop service"
          className="border-destructive/30 text-destructive hover:bg-destructive/10"
        >
          {stop.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
          Stop
        </Button>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => start.mutate()} title="Start service">
          {start.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          Start
        </Button>
      )}
    </div>
  );
}

function DownloadRow({ job }: { job: DownloadJob }) {
  const pct =
    job.totalBytes && job.totalBytes > 0
      ? Math.min(100, Math.round((job.bytesDownloaded / job.totalBytes) * 100))
      : null;
  const stateIcon =
    job.state === 'active' ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
    : job.state === 'done' ? <Check className="size-3.5 text-emerald-600" />
    : <XCircle className="size-3.5 text-destructive" />;
  const detail =
    job.state === 'active'
      ? `${formatBytes(job.bytesDownloaded)}${job.totalBytes ? ` of ${formatBytes(job.totalBytes)}` : ''} · file ${Math.min(job.filesDone + 1, job.filesTotal)}/${job.filesTotal}${job.currentFile ? ` · ${job.currentFile}` : ''}`
      : job.state === 'done'
        ? `${formatBytes(job.bytesDownloaded)} · ${job.filesTotal} files · done`
        : `failed: ${job.error ?? 'unknown error'}`;

  return (
    <li className="space-y-1.5 px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        {stateIcon}
        <span className="flex-1 truncate font-medium" title={job.repoId}>{job.repoId}</span>
        {pct !== null && job.state === 'active' && <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full transition-[width] duration-300 ease-out',
            job.state === 'done' ? 'bg-emerald-500' : job.state === 'error' ? 'bg-destructive' : 'bg-primary',
          )}
          style={{ width: pct !== null ? `${pct}%` : job.state === 'active' ? '5%' : '100%' }}
        />
      </div>
      <div className="truncate text-xs text-muted-foreground">{detail}</div>
    </li>
  );
}
