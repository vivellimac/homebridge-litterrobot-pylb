import type { Logger } from 'homebridge';

let root: Logger | null = null;

export const initRootLogger = (l: Logger): void => {
  if (!root) root = l;
};

type InfoArgs = Parameters<Logger['info']>;
type WarnArgs = Parameters<Logger['warn']>;
type ErrorArgs = Parameters<Logger['error']>;
type LogArgs = Parameters<Logger['log']>;
type SuccessArgs = Parameters<Logger['success']>;
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
  const log: Logger['log'] = (...a: LogArgs) => base.log(prefix, ...a);
  const success: Logger['success'] = (...a: SuccessArgs) => base.success(prefix, ...a);

  let debug: Logger['debug'] | undefined;
  if (typeof base.debug === 'function') {
    const dbg = base.debug.bind(base) as (...a: DebugArgs) => void;
    debug = (...a: DebugArgs) => dbg(prefix, ...a);
  } else {
    debug = undefined;
  }

  // Return a concrete Logger with all required methods overridden to include the prefix.
  const logger: Logger = { info, warn, error, log, success, debug };

  return logger;
};
