// [local] Startup step: copies the server switches saved in Settings > MobileUI into
// process.env, for the whitelisted keys the environment (_server/config.json, .env, the
// shell) does not set. Imported by server/index.ts right after './load-env.js', so it runs
// before any module reads these variables into a module-level constant.
//
// It must never stop the server from starting: any failure leaves the environment as it was.
import { appConfigDb } from '@/modules/database/index.js';

import { applyServerSettingOverrides, recordAppliedServerSettings } from './server-settings.js';

try {
  recordAppliedServerSettings(applyServerSettingOverrides({
    env: process.env,
    readStored: (key) => appConfigDb.get(key),
    log: (message) => console.log(message),
  }));
} catch (error) {
  console.error('[server-settings] Could not read the saved server switches; using the environment only:', error instanceof Error ? error.message : 'unknown error');
}
