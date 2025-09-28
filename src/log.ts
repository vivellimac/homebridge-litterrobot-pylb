import type { Logger } from 'homebridge';

let root: Logger | null = null;

export const initRootLogger = (l: Logger): void => {
  root ??= l;
};

export const rootLogger = (): Logger => {
  if (!root) {
    throw new Error('Logger not initialized');
  }
  return root;
};
