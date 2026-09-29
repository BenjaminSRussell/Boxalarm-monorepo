# Push: device verification checklist

The direct APNs/FCM push path (`feat/direct-push`) is covered by unit and contract tests, but several links can only be proven on a real phone. Run every item on a **release build** (TestFlight for iOS, a signed release APK/AAB for Android). Bridgeless mode is the React Native 0.87 default, so that is what gets tested.

Send each page from the stack under test (a manual dispatch or a self-test), with the stack's APNs secret `environment` matching the build (see `infrastructure/README.md`, "Push credentials").

## iOS

| # | Check | Pass when |
|---|---|---|
| 1 | Page with the app **killed**, phone locked | Banner and sound appear. With `interruptionLevel: time-sensitive`, the page also breaks through a Focus mode. |
| 2 | Page with the phone in **Sleep Focus** and the ring/silent switch on silent | `time-sensitive`: delivered through Focus. `critical` (only after #4 is granted and the member has allowed Critical Alerts): plays at full volume despite the switch. |
| 3 | Page with the app **open in the foreground** | A banner and sound are shown (AppDelegate `willPresent`). |
| 4 | **Cold-start tap**: kill the app, page, tap the notification | The app opens on that dispatch's alert detail. |
| 5 | **Warm tap, background**: app backgrounded (not killed), page, tap | The app comes forward on that dispatch's alert detail. This path depends on React Native's `settingsUpdated` event reaching JS in bridgeless mode (`pushRouting.ts`). If it does not, the app opens but stays on the current screen, and a native Linking fallback is needed. |
| 6 | **Warm tap, foreground**: app open on another screen, page, tap the banner | The app navigates to that dispatch's alert detail. Same dependency as 5. |
| 7 | Tone 2 while the tone-1 notification is still showing | A second, separate alert fires (per-tone `apns-collapse-id`). |
| 8 | Signing | The Time Sensitive Notifications capability is enabled on the App ID and present in every provisioning profile. Otherwise the signed build fails. |

## Android

| # | Check | Pass when |
|---|---|---|
| 9 | Page with the app killed, screen off, Do Not Disturb on | A full-screen dispatch notification appears on the `dispatch-critical` channel. |
| 10 | Page with the app **open in the foreground** | The same notification is posted (the `onMessage` handler). |
| 11 | Tap on the notification: app cold, app warm | The app opens on that dispatch's alert detail. |
| 12 | Phone offline for more than 10 minutes, then back online | Old pages do **not** ring (600s TTL). |

Record the device model, OS version, build number and stack for each run in the release notes.
