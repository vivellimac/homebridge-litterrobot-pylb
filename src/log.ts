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

  const prefix = `[${ns}]`;

  // Namespaced wrappers
  const info: Logger['info'] = (...a: InfoArgs) => root.info(prefix, ...a);
  const warn: Logger['warn'] = (...a: WarnArgs) => root.warn(prefix, ...a);
  const error: Logger['error'] = (...a: ErrorArgs) => root.error(prefix, ...a);

  // Build a Logger that preserves all base members and overrides the methods we care about.
  const base = root; // type narrowed to Logger after the null-check above

  const logger: Logger = {
    ...base,
    info,
    warn,
    error,
    ...(base.debug ? { debug: (...a: DebugArgs) => base.debug!(prefix, ...a) } : {}),
  };

  return logger;
};
