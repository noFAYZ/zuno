/**
 * Ambient window background.
 *
 * Adapted from docs/tauribg.txt: two blurred colour blobs bleeding down from the top edge,
 * over a radial vignette that darkens toward the bottom. The reference uses an indigo
 * `primary` plus `red-400`; here both blobs sit in the app's own accent family so the
 * backdrop reinforces the identity instead of introducing a second hue.
 *
 * Kept deliberately low-contrast: this sits behind real UI, so it must never compete with
 * text or controls. Callers gate it on Paper-PC mode (see Layout.tsx), which is also why
 * this is plain CSS — no WebGL, no animation, nothing to disable.
 *
 * The blooms are radial gradients, not blurred discs: a blurred solid circle *is* a radial
 * gradient, and drawing one directly costs no filter pass and no compositor layer.
 */
export function StarField() {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl"
      aria-hidden="true"
      data-fx="ambient"
    >
      {/*
        Both blooms share one opacity token (--ambient-bloom, set per theme in global.css).
        The same wash that reads as a faint glow over a near-black background reads as a
        pink stain over a near-white one, so the strength has to follow the theme.
      */}
      <div className="absolute inset-0" style={{ opacity: "var(--ambient-bloom)" }}>
        {/* Primary bloom, offset left of centre. */}
        <div className="absolute left-1/3 top-0 size-1/2 -translate-x-1/2 -translate-y-1/2 bg-radial from-orange-500/40 to-transparent to-70%" />
        {/* Warmer, smaller companion bloom to the right. */}
        <div className="absolute left-2/3 top-0 size-1/3 -translate-x-1/2 -translate-y-1/2 bg-radial from-rose-400/15 to-transparent to-70%" />
      </div>
      {/* Vignette: transparent at the top, settling into the window background. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% -60%, transparent 0%, color-mix(in oklab, var(--color-muted) 45%, transparent) 50%, color-mix(in oklab, var(--color-background) 85%, transparent) 100%)",
        }}
      />
    </div>
  );
}
