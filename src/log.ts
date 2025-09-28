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
  if (!root) throw new Error('Logger not initialized');
  if (!ns) return root;

  const prefix = `[${ns}]`;

  const info: Logger['info'] = (...a: InfoArgs) => root!.info(prefix, ...a);
  const warn: Logger['warn'] = (...a: WarnArgs) => root!.warn(prefix, ...a);
  const error: Logger['error'] = (...a: ErrorArgs) => root!.error(prefix, ...a);
  const debug: Logger['debug'] | undefined = root!.debug
    ? ((...a: DebugArgs) => (root!.debug as (...a: DebugArgs) => void)(prefix, ...a))
    : undefined;

  return Object.assign(Object.create(root), { info, warn, error, debug });
};
