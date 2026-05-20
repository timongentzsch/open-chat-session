// Keep assistant-ui mutations layout-neutral; message grouping in JS can jump on partial renders.
export const BUBBLE_AND_SPACING_CSS = `
[data-aui-role] + [data-aui-role] { margin-top: 2.5rem !important; }
[data-aui-role="user"] + [data-aui-role="user"],
[data-aui-role="assistant"] + [data-aui-role="assistant"] { margin-top: 0.125rem !important; }
.ocs-scroll-bottom:disabled { display: none; }

[data-aui-ocs-bubble] {
  --ocs-block-gap: 0.5rem;
  padding: 0.75rem;
  border: 0;
  border-radius: 0;
  box-sizing: border-box;
  line-height: 1.5;
  transition: background 120ms ease;
}
[data-aui-ocs-attachments],
[data-aui-ocs-attachment] {
  max-width: 100%;
  box-sizing: border-box;
}
[data-aui-role="user"] [data-aui-ocs-bubble] {
  background: color-mix(in srgb, var(--ocs-white) 12%, transparent);
}
[data-aui-role="assistant"] [data-aui-ocs-bubble] {
  background: color-mix(in srgb, var(--ocs-white) 6%, transparent);
}
[data-aui-role="user"]:hover [data-aui-ocs-bubble] {
  background: color-mix(in srgb, var(--ocs-white) 16%, transparent);
}
[data-aui-role="assistant"]:hover [data-aui-ocs-bubble] {
  background: color-mix(in srgb, var(--ocs-white) 9%, transparent);
}
[data-aui-ocs-bubble][data-aui-ocs-replyable] {
  min-height: 2.125rem;
}
[data-aui-ocs-reply-button] {
  background: var(--ocs-panel) !important;
  color: color-mix(in srgb, var(--ocs-white) 72%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ocs-panel) 82%, transparent);
}
[data-aui-ocs-reply-button]:hover {
  background: color-mix(in srgb, var(--ocs-white) 8%, var(--ocs-panel)) !important;
  color: var(--ocs-white);
}

[data-aui-role] audio {
  filter: invert(0.86) hue-rotate(180deg);
  border-radius: 0;
  width: 100%;
  height: var(--ocs-control-h, 36px);
}
`;

export const PLUGIN_CURSOR_CSS = `
[data-aui-ocs-plugin] {
  --ocs-bg: var(--background);
  --ocs-panel: var(--background);
  --ocs-white: var(--foreground-base);
  --ocs-text: var(--foreground-base);
  --ocs-mid: var(--midground);
  --ocs-success: var(--color-success);
  --ocs-danger: var(--color-destructive);
  --ocs-warn: var(--color-warning);
  --ocs-backdrop: color-mix(in srgb, var(--background-base) 70%, transparent);
  --ocs-border: color-mix(in srgb, var(--ocs-mid) 22%, transparent);
  --ocs-border-strong: color-mix(in srgb, var(--ocs-mid) 34%, transparent);
  --ocs-surface: color-mix(in srgb, var(--ocs-white) 2%, transparent);
  --ocs-surface-hover: color-mix(in srgb, var(--ocs-white) 5%, transparent);
  --ocs-surface-active: color-mix(in srgb, var(--ocs-white) 7%, transparent);
  --ocs-focus: color-mix(in srgb, var(--ocs-success) 54%, transparent);
  width: 100%;
  max-width: 100%;
  overflow: hidden;
}
[data-aui-ocs-plugin] * {
  box-sizing: border-box;
  border-radius: 0 !important;
  min-width: 0;
}
[data-aui-ocs-plugin] :where(
  button:not(:disabled),
  a[href],
  summary,
  select:not(:disabled),
  input[type="button"]:not(:disabled),
  input[type="submit"]:not(:disabled),
  input[type="reset"]:not(:disabled),
  input[type="checkbox"]:not(:disabled),
  input[type="radio"]:not(:disabled),
  input[type="file"]:not(:disabled),
  label[for],
  [role="button"]:not([aria-disabled="true"]),
  [data-aui-ocs-slash-item]
) {
  cursor: pointer;
}
[data-aui-ocs-plugin] :where(
  button:disabled,
  select:disabled,
  input:disabled,
  [aria-disabled="true"]
) {
  cursor: not-allowed;
}
[data-aui-ocs-plugin] :where(button, a[href], input, textarea, select, [role="button"], [data-aui-ocs-slash-item]) {
  -webkit-tap-highlight-color: transparent;
}
[data-aui-ocs-plugin] :where(button, a[href], input, textarea, select, [role="button"], [data-aui-ocs-slash-item]):focus-visible {
  outline: 1px solid var(--ocs-focus);
  outline-offset: 1px;
}
[data-aui-ocs-plugin] :where(button, [role="button"], [data-aui-ocs-slash-item]) {
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease,
    opacity 120ms ease;
}
[data-aui-ocs-plugin] :where(button:disabled, input:disabled, textarea:disabled, select:disabled, [aria-disabled="true"]) {
  opacity: 0.45;
}
[data-aui-ocs-plugin] :where(input, textarea, select) {
  background: transparent;
  border-color: var(--ocs-border);
  color: var(--ocs-text) !important;
  caret-color: var(--ocs-text);
}
[data-aui-ocs-plugin] :where(input, textarea, select):focus {
  border-color: var(--ocs-border-strong);
  box-shadow: none;
}
[data-aui-ocs-plugin] ::placeholder {
  color: color-mix(in srgb, var(--ocs-text) 44%, transparent);
}
[data-aui-ocs-header],
[data-aui-ocs-panel] {
  background: transparent;
}
[data-aui-ocs-header] {
  max-width: 100%;
  overflow: hidden;
}
[data-aui-ocs-control] {
  border-color: var(--ocs-border);
}
[data-aui-ocs-control]:where(:hover, [data-state="open"]):not(:disabled) {
  background: transparent;
  border-color: var(--ocs-border-strong);
}
[data-aui-ocs-session-row] {
  min-height: 2.625rem;
  border: 1px solid transparent;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
[data-aui-ocs-session-row="active"] {
  background: var(--ocs-surface-active);
  border-color: transparent;
  box-shadow: inset 2px 0 0 var(--ocs-border-strong);
}
[data-aui-ocs-session-row="idle"]:hover {
  background: var(--ocs-surface-hover);
}
[data-aui-ocs-composer] {
  box-shadow: 0 -1px 0 var(--ocs-border);
}
[data-aui-ocs-composer-attachment],
[data-aui-ocs-attachment],
[data-aui-ocs-card] {
  border-color: var(--ocs-border);
}
[data-aui-ocs-attachment] {
  background: var(--ocs-surface);
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
[data-aui-ocs-attachment]:hover {
  background: var(--ocs-surface-hover);
  border-color: var(--ocs-border-strong);
}
[data-aui-ocs-slash-popover] {
  --ocs-slash-max-h: min(18rem, 50vh);
  background: color-mix(in srgb, var(--ocs-panel) 92%, var(--ocs-white) 8%);
  border-color: var(--ocs-border-strong);
  left: 5.5rem;
  right: 0.75rem;
  bottom: calc(100% + 0.5rem);
  max-height: var(--ocs-slash-max-h);
  touch-action: pan-y;
}
[data-aui-ocs-slash-items] {
  max-height: calc(var(--ocs-slash-max-h) - 0.5rem);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--ocs-border-strong) transparent;
  -webkit-overflow-scrolling: touch;
}
[data-aui-ocs-slash-items]::-webkit-scrollbar { width: 0.5rem; }
[data-aui-ocs-slash-items]::-webkit-scrollbar-thumb {
  background: var(--ocs-border-strong);
  border: 2px solid transparent;
  background-clip: content-box;
}
[data-aui-ocs-slash-item] {
  min-height: 3rem;
  scroll-margin: 0.5rem;
  touch-action: manipulation;
}
`;

// Plain CSS keeps the plugin independent from the host's Tailwind build.
export const OCS_LAYOUT_CSS = `
[data-aui-ocs-plugin] {
  --ocs-control-h: 36px;
  min-width: 0;
  height: 100%;
  min-height: 0;
  overflow-x: hidden;
  overscroll-behavior: contain;
  background: var(--ocs-bg);
}
[data-aui-ocs-plugin] :where(header, main, aside, div, form) {
  min-width: 0;
}
[data-aui-ocs-plugin] main,
[data-aui-ocs-plugin] [data-aui-ocs-sidebar],
[data-aui-ocs-plugin] [data-aui-ocs-footer],
[data-aui-ocs-plugin] [data-aui-ocs-composer],
[data-aui-ocs-plugin] [data-aui-ocs-composer-row],
[data-aui-ocs-plugin] [data-aui-ocs-bubble] {
  max-width: 100%;
}
[data-aui-ocs-plugin] [data-aui-ocs-footer] {
  background: var(--ocs-bg);
}
[data-aui-ocs-plugin] [data-aui-ocs-header] {
  padding-left: 1rem;
  padding-right: 1rem;
}
[data-aui-ocs-plugin] [data-aui-ocs-thread-viewport] {
  padding-left: 1rem;
  padding-right: 1rem;
}
[data-aui-ocs-composer-row] > [data-aui-ocs-control],
[data-aui-ocs-field] { height: var(--ocs-control-h); min-height: var(--ocs-control-h); }

main:has([data-aui-ocs-plugin]) {
  position: relative;
  overflow: hidden !important;
  scrollbar-gutter: auto !important;
}
main:has([data-aui-ocs-plugin]) > div {
  padding: 0 !important;
}

[data-aui-ocs-sidebar] {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 50;
  transform: translateX(-100%);
  transition: transform 200ms ease-out;
}
[data-aui-ocs-sidebar][data-open="true"] {
  transform: translateX(0);
}

[data-aui-ocs-backdrop] {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: var(--ocs-backdrop);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}

[data-aui-ocs-mobile-only] { display: inline-flex; }

@media (max-width: 640px) {
  main:has([data-aui-ocs-plugin]) {
    background: var(--ocs-bg);
  }
  [data-aui-ocs-header] {
    gap: 0.5rem;
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
    padding-left: 0.625rem;
    padding-right: 0.625rem;
  }
  [data-aui-ocs-push] {
    display: none;
  }
  [data-aui-ocs-plugin] [data-aui-ocs-thread-viewport] {
    padding-left: 0.75rem;
    padding-right: 0.75rem;
  }
  [data-aui-ocs-plugin] [data-aui-ocs-footer] {
    padding-bottom: 0.75rem;
  }
  [data-aui-ocs-plugin] [data-aui-ocs-composer] {
    padding-left: 0.5rem;
    padding-right: 0.5rem;
  }
  [data-aui-ocs-plugin] :where(input, textarea, select) {
    font-size: 16px !important;
    line-height: 1.35;
  }
  [data-aui-ocs-plugin] [data-aui-ocs-composer-row] {
    gap: 0.375rem;
  }
  [data-aui-ocs-plugin] [data-aui-ocs-composer-row] > [data-aui-ocs-control] {
    min-width: 2.125rem;
  }
  [data-aui-ocs-plugin] [data-aui-ocs-slash-popover] {
    --ocs-slash-max-h: min(20rem, 46vh);
    left: 0.5rem;
    right: 0.5rem;
  }
  [data-aui-ocs-plugin] [data-aui-role] > div {
    max-width: min(88%, 34rem);
  }
}

@media (min-width: 1024px) {
  [data-aui-ocs-sidebar] {
    position: relative;
    transform: none;
    transition: none;
    z-index: auto;
  }
  [data-aui-ocs-backdrop] { display: none; }
  [data-aui-ocs-mobile-only] { display: none; }
}
`;

export const SLASH_ITEM_CSS = `
[data-aui-ocs-slash-item]:hover { background: color-mix(in srgb, var(--ocs-white) 6%, transparent); }
[data-aui-ocs-slash-item][data-highlighted] { background: color-mix(in srgb, var(--ocs-white) 12%, transparent); }
`;

// Streamdown/Shiki should inherit the bubble colors.
export const MARKDOWN_COLOR_CSS = `
.ocs-markdown,
.ocs-markdown :where(p, li, h1, h2, h3, h4, h5, h6, td, th, strong, em, code, pre, span, a) {
  color: inherit;
}
.ocs-markdown {
  line-height: 1.5;
}
.ocs-markdown :where(p, ul, ol, blockquote, table, pre, [data-aui-ocs-code="block"]) {
  margin-block: 0 !important;
}
.ocs-markdown :where(p, ul, ol, blockquote, table, pre, [data-aui-ocs-code="block"])
  + :where(p, ul, ol, blockquote, table, pre, [data-aui-ocs-code="block"]) {
  margin-top: var(--ocs-block-gap, 0.5rem) !important;
}
.ocs-markdown code {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.ocs-markdown [data-aui-ocs-code="block"] {
  display: block;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  white-space: pre;
  overflow-x: auto;
  padding: 0.625rem 0.75rem;
  margin: 0 !important;
  border-radius: 0;
  border: 1px solid color-mix(in srgb, var(--ocs-mid) 20%, transparent);
  background: color-mix(in srgb, var(--ocs-white) 7%, transparent) !important;
  color: inherit !important;
  font-size: 0.8125rem;
  line-height: 1.45;
}
.ocs-markdown :where(table, pre, code, [data-aui-ocs-code="block"]) {
  max-width: 100%;
}
.ocs-markdown :where(table) {
  display: block;
  overflow-x: auto;
}
.ocs-markdown [data-aui-ocs-code="inline"] {
  border-radius: 0;
  background: color-mix(in srgb, var(--ocs-white) 10%, transparent) !important;
  color: inherit !important;
  overflow-wrap: anywhere;
}
`;

export const COMPOSER_CSS = `
[data-aui-ocs-composer] {
  border-top: 1px solid color-mix(in srgb, var(--ocs-mid) 20%, transparent);
  background: transparent;
}
[data-aui-ocs-composer] :where(textarea, input, [contenteditable="true"]) {
  color: var(--ocs-text) !important;
  caret-color: var(--ocs-text);
  -webkit-text-fill-color: var(--ocs-text);
}
[data-aui-ocs-composer] :where(textarea, input)::placeholder {
  color: color-mix(in srgb, var(--ocs-white) 42%, transparent);
}
[data-aui-ocs-composer][data-dragging] {
  background: color-mix(in srgb, var(--ocs-white) 4%, transparent);
}
`;

export const BANNER_CSS = `
[data-aui-ocs-banner-tone="destructive"] {
  background: color-mix(in srgb, var(--ocs-danger) 10%, transparent);
}
[data-aui-ocs-banner-tone="warning"] {
  background: color-mix(in srgb, var(--ocs-warn) 8%, transparent);
}
[data-aui-ocs-banner-tone="midground"] {
  background: color-mix(in srgb, var(--ocs-white) 4%, transparent);
}
`;

export const SURFACE_CSS = `
[data-aui-ocs-surface="dim"] {
  background: color-mix(in srgb, var(--ocs-white) 2%, transparent);
}
[data-aui-ocs-surface="mid"] {
  background: color-mix(in srgb, var(--ocs-white) 4%, transparent);
}
`;
