import { useState } from 'react';

/** A comment left on a suggestion (Suggestions page: a pattern proposal or a mix change). */
export interface SuggestionComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The comments on a suggestion, oldest first: who, when, what. */
export function CommentList({ comments }: { comments: readonly SuggestionComment[] }) {
  if (comments.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Comments">
      {comments.map((c) => (
        <li key={c.id} className="rounded-[8px] bg-white/[0.04] px-3 py-2">
          <div className="text-[11px] text-white/45">
            {c.author} · {when(c.createdAt)}
          </div>
          <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-white/85">{c.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** Comments plus a box to add one (the mix changes' Comment). */
export function CommentBox({
  comments,
  onComment,
  pending,
  error,
}: {
  comments: readonly SuggestionComment[];
  onComment: (body: string) => Promise<unknown>;
  pending: boolean;
  error: string | undefined;
}) {
  const [text, setText] = useState('');
  return (
    <div className="flex flex-col gap-2">
      <CommentList comments={comments} />
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="Leave a comment"
          aria-label="Comment"
          className="min-w-0 flex-1 rounded-[8px] border border-line bg-bg px-3 py-2 text-[13px] text-white outline-none focus:border-white/50"
        />
        <button
          type="button"
          disabled={pending || !text.trim()}
          onClick={() => void onComment(text.trim()).then(() => setText(''))}
          className="h-9 rounded-full border border-line px-4 text-[13px] font-semibold text-white hover:border-white/60 disabled:opacity-40"
        >
          {pending ? 'Saving…' : 'Comment'}
        </button>
      </div>
      {error ? <p className="text-[12px] text-err">Not saved: {error}</p> : null}
    </div>
  );
}
