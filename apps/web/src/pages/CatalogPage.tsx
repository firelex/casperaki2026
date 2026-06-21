import { useSearchParams } from 'react-router-dom';

import { AppHeader } from '../layout/AppHeader';
import { CatalogBrowser } from '../editor/CatalogBrowser';

/**
 * Catalog browser page.
 *
 * Renders the read-only validated catalog under the standard AppHeader,
 * so the user can pivot in from Projects / Editor "view in catalog"
 * affordances. A `?focus=<catalogId>` search param pre-selects an entry.
 */
export function CatalogPage() {
  const [params] = useSearchParams();
  const focus = params.get('focus') ?? undefined;
  return (
    <div className="flex flex-col h-screen w-screen bg-bg text-white">
      <AppHeader />
      <main className="flex-1 min-h-0 flex flex-col">
        <header className="px-8 pt-6 pb-3">
          <h1 className="text-[24px] font-semibold leading-tight">Sample Library Catalog</h1>
          <p className="text-[12px] text-muted mt-1 max-w-[640px]">
            Read-only browser over the validated catalog — the audit-passing
            intersection of the xlsx instrument snapshot and the sample-library
            disk audit. The brain selects only from these entries; missing
            rows are filtered at the loader boundary.
          </p>
        </header>
        <div className="flex-1 min-h-0 border-t border-line/60">
          <CatalogBrowser initialFocusId={focus} />
        </div>
      </main>
    </div>
  );
}
