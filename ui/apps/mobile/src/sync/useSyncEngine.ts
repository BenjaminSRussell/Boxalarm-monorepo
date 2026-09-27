import { useEffect, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../auth/AuthContext';
import * as syncManager from './syncManager';

/**
 * Points the offline outbox at the API for as long as the app is signed in. Mounted once at the
 * app root so work queued in an earlier session (a truck check, a field capture, attendance)
 * drains on launch and on reconnect regardless of which tab the member opens first - previously
 * only the Checks screens configured it, so nothing drained until someone opened Checks.
 */
export function useSyncEngine(): void {
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const isAuthenticated = auth?.isAuthenticated ?? false;
  // The token source is read through a ref so a token refresh never re-runs configure().
  const authRef = useRef(auth);
  authRef.current = auth;

  useEffect(() => {
    const tokens = apiBaseUrl && isAuthenticated ? (authRef.current ?? null) : null;
    syncManager.configure(tokens, apiBaseUrl || null);
  }, [apiBaseUrl, isAuthenticated]);
}
