import { createNavigationContainerRef } from '@react-navigation/native';
import type { AppTabsParamList } from './AppTabs';

export const navigationRef = createNavigationContainerRef<AppTabsParamList>();

export function navigateToAlertDetail(dispatchId: string): void {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate('Alerts', { screen: 'AlertDetail', params: { dispatchId } });
}

export function isNavigationReady(): boolean {
  return navigationRef.isReady();
}

/** Calls `listener` whenever the navigation state changes (including when it first mounts). */
export function onNavigationStateChange(listener: () => void): () => void {
  return navigationRef.addListener('state', listener);
}
