// Tighten the gap between consecutive messages from the same role. Done in
// CSS rather than JS because mutable closure state inside ThreadPrimitive.Messages
// desyncs on partial re-renders and causes a visible vertical jump on hover.
export const BUBBLE_AND_SPACING_CSS = `
[data-aui-role] + [data-aui-role] { margin-top: 2.5rem !important; }
[data-aui-role="user"] + [data-aui-role="user"],
[data-aui-role="assistant"] + [data-aui-role="assistant"] { margin-top: 0.125rem !important; }
.ocs-scroll-bottom:disabled { display: none; }

/* Bubble surfaces. The host's compiled Tailwind ships only a sparse set of
   bg-foreground/<n> alpha steps and no arbitrary values, so utility classes
   like bg-foreground/10 silently no-op here. Style the inner pill via the
   parent's data-aui-role attribute instead. Borderless and tighter padding
   for a cleaner look than the prior border + fill combo. */
[data-aui-role] > div {
  padding: 0.45rem 0.75rem;
  border: 0;
  transition: background 120ms ease;
}
[data-aui-role="user"] > div {
  background: color-mix(in srgb, var(--foreground-base, #fff) 12%, transparent);
}
[data-aui-role="assistant"] > div {
  background: color-mix(in srgb, var(--foreground-base, #fff) 6%, transparent);
}
[data-aui-role="user"]:hover > div {
  background: color-mix(in srgb, var(--foreground-base, #fff) 16%, transparent);
}
[data-aui-role="assistant"]:hover > div {
  background: color-mix(in srgb, var(--foreground-base, #fff) 9%, transparent);
}

/* Render embedded <audio> with a slim dark filter so the default browser
   chrome doesn't fight the theme. Scoped to chat bubbles so we don't
   touch audio in other plugins. */
[data-aui-role] audio {
  filter: invert(0.86) hue-rotate(180deg);
  border-radius: 0.25rem;
  width: 100%;
  height: 36px;
}
`;

// Highlight + hover styles for slash-popup items. The host's Tailwind doesn't
// emit `data-[highlighted]:...` variants or arbitrary `bg-foreground/[0.08]`
// classes, so inline scoped CSS via React 19's `<style precedence>` is the
// reliable channel for this state.
export const SLASH_ITEM_CSS = `
[data-aui-ocs-slash-item]:hover { background: color-mix(in srgb, var(--foreground-base, #fff) 6%, transparent); }
[data-aui-ocs-slash-item][data-highlighted] { background: color-mix(in srgb, var(--foreground-base, #fff) 12%, transparent); }
`;

// Markdown reset + Shiki theme override.
// Streamdown's fenced-code rendering wires Shiki's `--sdm-bg`/`--sdm-fg` CSS
// variables; the default `github-light/github-dark` pair lights up cream-on-cream
// on our surface. Force inherit so blocks pick up the bubble's foreground/bg.
export const MARKDOWN_COLOR_CSS = `
.ocs-markdown,
.ocs-markdown :where(p, li, h1, h2, h3, h4, h5, h6, td, th, strong, em, code, pre, span, a) {
  color: inherit;
}
.ocs-markdown code {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
/* Block-level fenced code. Streamdown renders the fenced block as a bare
   <code> (no <pre> wrapper) and ships Shiki vars; override both. */
.ocs-markdown [data-aui-ocs-code="block"] {
  display: block;
  white-space: pre;
  overflow-x: auto;
  padding: 0.5rem 0.75rem;
  margin: 0.5rem 0;
  border-radius: 0.375rem;
  border: 1px solid color-mix(in srgb, var(--midground, #888) 20%, transparent);
  background: rgba(0, 0, 0, 0.22) !important;
  color: inherit !important;
  font-size: 0.8125rem;
  line-height: 1.45;
}
/* Inline code chips override Shiki vars too (they leak onto plain inline). */
.ocs-markdown [data-aui-ocs-code="inline"] {
  background: rgba(0, 0, 0, 0.22) !important;
  color: inherit !important;
}
`;

// Dropzone background for Composer. The host's Tailwind doesn't ship
// bg-foreground/[0.02] or bg-foreground/[0.06] arbitrary values, and
// data-[dragging]:... variants are also absent.
export const COMPOSER_CSS = `
[data-aui-ocs-composer] {
  border-top: 1px solid color-mix(in srgb, var(--midground, #888) 20%, transparent);
  background: color-mix(in srgb, var(--foreground-base, #fff) 2%, transparent);
}
[data-aui-ocs-composer][data-dragging] {
  background: color-mix(in srgb, var(--foreground-base, #fff) 6%, transparent);
}
`;

// Banner tone backgrounds. Rose and amber/10 are absent from host CSS.
// Keyed by data-aui-ocs-banner-tone attribute set on the Banner wrapper div.
export const BANNER_CSS = `
[data-aui-ocs-banner-tone="rose"] {
  background: color-mix(in srgb, #f43f5e 10%, transparent);
}
[data-aui-ocs-banner-tone="amber"] {
  background: color-mix(in srgb, #f59e0b 8%, transparent);
}
[data-aui-ocs-banner-tone="midground"] {
  background: color-mix(in srgb, var(--foreground-base, #fff) 4%, transparent);
}
`;

// Approval panel card backgrounds. bg-amber-500/[0.05] and bg-rose-500/[0.04]
// and bg-emerald-500/[0.04] are absent from host CSS.
export const APPROVAL_CSS = `
[data-aui-ocs-card="pending"] {
  background: color-mix(in srgb, #f59e0b 5%, transparent);
}
[data-aui-ocs-card="resolved-denied"] {
  background: color-mix(in srgb, #f43f5e 4%, transparent);
}
[data-aui-ocs-card="resolved-allowed"] {
  background: color-mix(in srgb, #10b981 4%, transparent);
}
`;
