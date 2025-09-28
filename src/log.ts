import type { Logger } from 'homebridge';

let root: Logger | null = null;

export const initRootLogger = (l: Logger): void => {
  if (!root) root = l;
};

type LogLevelParam = Parameters<Logger['log']>[0];

const tail = (params: unknown[]): string =>
  params.length
    ? ' ' +
      params
        .map((p) => (typeof p === 'string' ? p : (() => { try { return JSON.stringify(p); } catch { return String(p); } })()))
        .join(' ')
    : '';

export const getLogger = (ns?: string): Logger => {
  if (!root) {
    throw new Error('Logger not initialized');
  }
  if (!ns) {
    return root;
  }

  const base = root;
  const prefix = `[${ns}] `;

  const info: Logger['info'] = (message: string, ...parameters: unknown[]) =>
    base.info(`${prefix}${message}${tail(parameters)}`);

  const warn: Logger['warn'] = (message: string, ...parameters: unknown[]) =>
    base.warn(`${prefix}${message}${tail(parameters)}`);

  const error: Logger['error'] = (message: string, ...parameters: unknown[]) =>
    base.error(`${prefix}${message}${tail(parameters)}`);

  const success: Logger['success'] = (message: string, ...parameters: unknown[]) =>
    base.success(`${prefix}${message}${tail(parameters)}`);

  const log: Logger['log'] = (level: LogLevelParam, message: string, ...parameters: unknown[]) =>
    base.log(level, `${prefix}${message}${tail(parameters)}`);

  // Always provide a debug; fall back to info if base.debug isn't present at runtime
  const debugImpl = typeof base.debug === 'function' ? base.debug.bind(base) : base.info.bind(base);
  const debug: Logger['debug'] = (message: string, ...parameters: unknown[]) =>
    debugImpl(`${prefix}${message}${tail(parameters)}`);

  // Return a concrete Logger with required methods
  const logger: Logger = { info, warn, error, success, log, debug };
  return logger;
};
