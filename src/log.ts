import type { Logger } from 'homebridge';

let root: Logger | null = null;

export const initRootLogger = (l: Logger): void => {
  if (!root) root = l;
};

type InfoArgs = Parameters<Logger['info']>;
type WarnArgs = Parameters<Logger['warn']>;
type ErrorArgs = Parameters<Logger['error']>;
type SuccessArgs = Parameters<Logger['success']>;
type LogArgs = Parameters<Logger['log']>;     // [level, message, ...parameters]
type DebugArgs = Parameters<Logger['debug']>;  // (message, ...parameters)

export const getLogger = (ns?: string): Logger => {
  if (!root) {
    throw new Error('Logger not initialized');
  }
  if (!ns) {
    return root;
  }

  const base = root;
  const prefix = `[${ns}] `;

  // Prefix the message argument for each method
  const info: Logger['info'] = (message: InfoArgs[0], ...parameters: InfoArgs.slice(1)) =>
    base.info(`${prefix}${message}`, ...parameters);

  const warn: Logger['warn'] = (message: WarnArgs[0], ...parameters: WarnArgs.slice(1)) =>
    base.warn(`${prefix}${message}`, ...parameters);

  const error: Logger['error'] = (message: ErrorArgs[0], ...parameters: ErrorArgs.slice(1)) =>
    base.error(`${prefix}${message}`, ...parameters);

  const success: Logger['success'] = (message: SuccessArgs[0], ...parameters: SuccessArgs.slice(1)) =>
    base.success(`${prefix}${message}`, ...parameters);

  const log: Logger['log'] = (level: LogArgs[0], message: LogArgs[1], ...parameters: LogArgs.slice(2)) =>
    base.log(level, `${prefix}${message}`, ...parameters);

  // Always provide a debug; fall back to info if base.debug is missing
  const debugImpl = typeof base.debug === 'function'
    ? base.debug.bind(base)
    : base.info.bind(base);

  const debug: Logger['debug'] = (message: DebugArgs[0], ...parameters: DebugArgs.slice(1)) =>
    debugImpl(`${prefix}${message}`, ...parameters);

  // Return concrete Logger (no spreads that drop members)
  const logger: Logger = { info, warn, error, success, log, debug };
  return logger;
};
