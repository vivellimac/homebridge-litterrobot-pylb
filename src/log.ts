import type { Logger } from 'homebridge';

let root: Logger | null = null;

export const initRootLogger = (l: Logger): void => {
  if (!root) root = l;
};

type InfoArgs = Parameters<Logger['info']>;
type WarnArgs = Parameters<Logger['warn']>;
type ErrorArgs = Parameters<Logger['error']>;
type DebugArgs = Logger['debug'] extends (...a: infer P) => any ? P : never;

export const getLogger = (ns?: string): Logger => {
  if (!root) {
    throw new Error('Logger not initialized');
  }
  if (!ns) {
    return root;
  }

  const base = root; // narrowed
  const prefix = `[${ns}]`;

  const info: Logger['info'] = (...a: InfoArgs) => base.info(prefix, ...a);
  const warn: Logger['warn'] = (...a: WarnArgs) => base.warn(prefix, ...a);
  const error: Logger['error'] = (...a: ErrorArgs) => base.error(prefix, ...a);

  let debug: Logger['debug'] | undefined;
  if (typeof base.debug === 'function') {
    const dbg = base.debug.bind(base) as (...a: DebugArgs) => void;
    debug = (...a: DebugArgs) => dbg(prefix, ...a);
  }

  const logger: Logger = {
    ...base,
    info,
    warn,
    error,
    ...(debug ? { debug } : {}),
  };

  return logger;
};
