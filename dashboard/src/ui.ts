export const panelTitle =
  "font-mondwest text-sm uppercase tracking-[0.12em] text-midground/70";

export const controlBase =
  "inline-flex h-9 items-center justify-center rounded-md border text-xs transition focus:outline-none focus:ring-1 focus:ring-foreground/30 disabled:opacity-40";

export const iconButton =
  `${controlBase} w-9 border-midground/30 text-midground/70 hover:bg-foreground/[0.04] hover:text-foreground`;

export const actionButton =
  `${controlBase} px-3 font-medium`;

export const fieldBase =
  "h-9 min-w-0 rounded-md border border-midground/30 bg-transparent px-2 text-sm leading-5 placeholder:text-midground/50 focus:border-foreground/60 focus:outline-none focus:ring-1 focus:ring-foreground/20";

export const composerControlStyle = {
  height: 36,
  minHeight: 36,
};

export const composerIconStyle = {
  ...composerControlStyle,
  width: 36,
  minWidth: 36,
};
