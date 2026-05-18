// `react/jsx-runtime` alias target. Assistant-ui's compiled output uses
// the automatic JSX transform; redirect those calls through the host's
// React.createElement so there's only ever one React instance.

import type React from "react";
import R from "./react";

export const Fragment = R.Fragment;

export function jsx(
  type: React.ElementType,
  props: Record<string, unknown>,
  key?: string,
): React.ReactElement {
  return R.createElement(type, key !== undefined ? { ...props, key } : props);
}

// `jsxs` is the static-children variant — semantically identical via createElement.
export const jsxs = jsx;
export const jsxDEV = jsx;
