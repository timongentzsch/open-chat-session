// `react` alias target. All third-party React imports (assistant-ui,
// radix-ui, zustand) resolve to this file so they share the host's React
// instance from `window.__HERMES_PLUGIN_SDK__.React`. Two React copies
// would silently break hooks + context.

const sdk = (typeof window !== "undefined" ? window.__HERMES_PLUGIN_SDK__ : undefined);
if (!sdk?.React) {
  throw new Error("[open-chat-session] window.__HERMES_PLUGIN_SDK__.React missing");
}
const R: any = sdk.React;

export default R;
export const {
  Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense,
  cloneElement, createContext, createElement, createRef, forwardRef, isValidElement,
  lazy, memo, startTransition,
  useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useId,
  useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useOptimistic,
  useReducer, useRef, useState, useSyncExternalStore, useTransition, use,
  version,
} = R;
