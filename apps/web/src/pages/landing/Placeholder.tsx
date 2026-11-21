/**
 * Image slot awaiting artwork. Each slot has a stable `slot` id (also on
 * the element as data-image-slot) so the real image can be dropped in
 * later: put the file in public/landing/ and replace the placeholder with
 * an <img>. The note says what the image should show.
 */
export function Placeholder({
  slot,
  note,
  ratio,
  className = '',
}: {
  slot: string;
  note: string;
  /** CSS aspect-ratio, e.g. "16 / 10". */
  ratio: string;
  className?: string;
}) {
  return (
    <figure
      data-image-slot={slot}
      role="img"
      aria-label={`Image to come: ${note}`}
      className={`landing-placeholder relative overflow-hidden rounded-[6px] ${className}`}
      style={{ aspectRatio: ratio }}
    >
      <figcaption className="absolute left-4 bottom-3 right-4 text-[13px] leading-snug text-white/55">
        <span className="text-white/80">{slot}</span>
        <br />
        {note}
      </figcaption>
    </figure>
  );
}
