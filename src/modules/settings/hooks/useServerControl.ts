// [local] Settings > Server: status and control of a server started by scripts/server/.
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ServerControlStatus } from '@/shared/types';

type ServerControlOverview =
  | { managed: false }
  | { managed: true; instance: 'live' | 'staging'; platform: string; status: ServerControlStatus };

type ServerControlAction = 'autostart' | 'restart' | 'stop';

type UseServerControlArgs = {
  // Settings is open: load once to know whether the Server tab exists at all.
  isOpen: boolean;
  // The Server tab is shown: keep the status fresh.
  isActive: boolean;
};

const POLL_INTERVAL_MS = 10_000;

/** Used by Settings (to show the Server tab only for a script-managed server) and by ServerSettingsTab. */
export function useServerControl({ isOpen, isActive }: UseServerControlArgs) {
  // Whether a script started this server (instant answer, no script run); decides
  // whether Settings offers the Server tab at all. null until known.
  const [available, setAvailable] = useState<boolean | null>(null);
  // Last answer of the status endpoint; null until the first load finishes.
  const [overview, setOverview] = useState<ServerControlOverview | null>(null);
  // Message of the last failed request, shown in the tab until the next success.
  const [error, setError] = useState<string | null>(null);
  // The request in flight, to disable the controls and label the busy one.
  const [pendingAction, setPendingAction] = useState<ServerControlAction | null>(null);
  // A restart or stop the server accepted; it runs detached after a short delay, so the
  // page says what happens next instead of looking frozen while the server goes away.
  const [scheduled, setScheduled] = useState<{ action: 'restart' | 'stop'; previousPid: number | null } | null>(null);
  // Stops responses that arrive after Settings closed from touching state.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // refresh reads the scheduled state without depending on it.
  const scheduledRef = useRef(scheduled);
  useEffect(() => {
    scheduledRef.current = scheduled;
  }, [scheduled]);

  const refresh = useCallback(async (): Promise<ServerControlOverview | null> => {
    try {
      const body = await readApiJson<{ data: ServerControlOverview }>(await api.serverControl.status());
      if (!mountedRef.current) return body.data;
      setOverview(body.data);
      setError(null);
      // A restart is over once a different process answers.
      setScheduled((current) => {
        if (current?.action === 'restart' && body.data.managed && body.data.status.running && body.data.status.pid !== current.previousPid) {
          return null;
        }
        return current;
      });
      return body.data;
    } catch (requestError) {
      // While a restart or stop runs, the server is expected to be unreachable.
      if (mountedRef.current && !scheduledRef.current) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
      return null;
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    api.serverControl.availability()
      .then((response) => readApiJson<{ data: { managed: boolean } }>(response))
      .then((body) => {
        if (mountedRef.current) setAvailable(body.data.managed);
      })
      .catch(() => {
        // An older server without these routes: no Server tab.
        if (mountedRef.current) setAvailable(false);
      });
  }, [isOpen]);

  // The status runs a script (about a second on Windows): only while the tab is shown.
  useEffect(() => {
    if (!isOpen || !isActive) return undefined;
    void refresh();
    const interval = window.setInterval(() => void refresh(), scheduled ? 3_000 : POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [isOpen, isActive, refresh, scheduled]);

  const runAction = useCallback(async (action: ServerControlAction, request: () => Promise<Response>) => {
    setPendingAction(action);
    setError(null);
    try {
      await readApiJson(await request());
      return true;
    } catch (requestError) {
      if (mountedRef.current) setError(requestError instanceof Error ? requestError.message : String(requestError));
      return false;
    } finally {
      if (mountedRef.current) setPendingAction(null);
    }
  }, []);

  const setAutostart = useCallback(async (enabled: boolean) => {
    if (await runAction('autostart', () => api.serverControl.setAutostart(enabled))) await refresh();
  }, [refresh, runAction]);

  const currentPid = overview?.managed ? overview.status.pid : null;

  const restart = useCallback(async (deploy: boolean) => {
    if (await runAction('restart', () => api.serverControl.restart(deploy))) {
      setScheduled({ action: 'restart', previousPid: currentPid });
    }
  }, [currentPid, runAction]);

  const stop = useCallback(async () => {
    if (await runAction('stop', () => api.serverControl.stop())) {
      setScheduled({ action: 'stop', previousPid: currentPid });
    }
  }, [currentPid, runAction]);

  return {
    overview,
    managed: available === true,
    error,
    pendingAction,
    scheduled,
    refresh,
    setAutostart,
    restart,
    stop,
  };
}
