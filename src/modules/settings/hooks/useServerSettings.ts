// [local] Settings > MobileUI: the server switches (GET/PATCH /api/server-control/settings).
// Saving writes the server's database only; the running server picks a value up after a restart.
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { IS_PLATFORM } from '@/shared/utils';

export type ServerSettingId =
  | 'codexRuntime'
  | 'toolApprovalTimeoutMs'
  | 'backgroundMaxHoldMs'
  | 'fileTreeMaxEntries'
  | 'extraReadRoots';

export type ServerSettingView = {
  id: ServerSettingId;
  envKey: string;
  /** config: set by the server's configuration (locked here); ui: saved here; default: neither. */
  source: 'config' | 'ui' | 'default';
  running: string | null;
  saved: string | null;
  pendingRestart: boolean;
};

export type ServerSettingsOverview = {
  available: boolean;
  instance: 'live' | 'staging' | null;
  settings: ServerSettingView[];
};

export function useServerSettings() {
  // null until loaded; stays null when the server has no such endpoint or on the hosted build.
  const [overview, setOverview] = useState<ServerSettingsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<ServerSettingId | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (IS_PLATFORM) return undefined;
    api.serverControl.settings()
      .then((response) => readApiJson<{ data: ServerSettingsOverview }>(response))
      .then((body) => {
        if (mountedRef.current) setOverview(body.data);
      })
      .catch(() => {
        // An older server, or none of this applies: no server switches.
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const save = useCallback(async (id: ServerSettingId, value: unknown) => {
    setSaving(id);
    setError(null);
    try {
      const body = await readApiJson<{ data: ServerSettingsOverview }>(await api.serverControl.saveSettings({ [id]: value }));
      if (mountedRef.current) setOverview(body.data);
      return true;
    } catch (requestError) {
      if (mountedRef.current) setError(requestError instanceof Error ? requestError.message : String(requestError));
      return false;
    } finally {
      if (mountedRef.current) setSaving(null);
    }
  }, []);

  const get = useCallback(
    (id: ServerSettingId) => overview?.settings.find((setting) => setting.id === id) ?? null,
    [overview],
  );

  return { overview, error, saving, save, get };
}
