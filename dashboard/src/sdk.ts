// Typed views onto `window.__HERMES_PLUGIN_SDK__`. The host exposes
// React, a small hook set, design-system components, and utilities so
// plugin bundles don't duplicate them — see `web/src/plugins/registry.ts`
// in hermes-agent. `import type` is erased; nothing here is bundled.
// Throws at module eval if the SDK isn't installed so a plugin loaded
// outside `hermes dashboard` fails loudly.

import type * as ReactNS from "react";

type HermesPluginSDK = {
  React: typeof ReactNS;
  hooks: {
    useState: typeof ReactNS.useState;
    useEffect: typeof ReactNS.useEffect;
    useCallback: typeof ReactNS.useCallback;
    useMemo: typeof ReactNS.useMemo;
    useRef: typeof ReactNS.useRef;
  };
  components: Record<string, unknown>;
  utils: {
    cn: (...args: unknown[]) => string;
  };
};

declare global {
  interface Window {
    __HERMES_PLUGIN_SDK__?: HermesPluginSDK;
    __HERMES_PLUGINS__?: {
      register: (name: string, component: ReactNS.ComponentType) => void;
      registerSlot: (plugin: string, slot: string, component: ReactNS.ComponentType) => void;
    };
    __HERMES_SESSION_TOKEN__?: string;
  }
}

function _sdk(): HermesPluginSDK {
  const sdk = window.__HERMES_PLUGIN_SDK__;
  if (!sdk) {
    throw new Error(
      "Hermes Plugin SDK not available. This plugin must be loaded by the hermes dashboard.",
    );
  }
  return sdk;
}

const SDK = _sdk();

export const React: typeof ReactNS = SDK.React;
export const {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} = SDK.hooks;
// `useSyncExternalStore` isn't in `SDK.hooks` but is on the React module.
export const useSyncExternalStore: typeof ReactNS.useSyncExternalStore =
  SDK.React.useSyncExternalStore;

export const cn: (...args: unknown[]) => string = SDK.utils.cn;
