import type { API } from 'homebridge';
import { PLATFORM_NAME } from './settings.js';
import { LitterRobotPlatform } from './platform.js';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, LitterRobotPlatform);
};
