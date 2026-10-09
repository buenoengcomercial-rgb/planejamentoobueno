declare const __APP_BUILD__: { revision: string; builtAt: string };
export const APP_BUILD = typeof __APP_BUILD__ === 'undefined'
  ? { revision: 'development', builtAt: '' }
  : __APP_BUILD__;
