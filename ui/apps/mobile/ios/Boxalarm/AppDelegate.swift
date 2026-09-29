import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import FirebaseCore
import UserNotifications
// RNAppAuthAuthorizationFlowManager(Delegate) come in via the Objective-C bridging header
// (Boxalarm-Bridging-Header.h) — react-native-app-auth is a plain static-lib pod with no
// Swift module map, so `import` can't see its headers here.

@main
class AppDelegate: UIResponder, UIApplicationDelegate, RNAppAuthAuthorizationFlowManager,
  UNUserNotificationCenterDelegate
{
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  // react-native-app-auth: holds the in-flight PKCE session so the `boxalarm://auth`
  // callback can resume it instead of dying silently when the system browser returns.
  weak var authorizationFlowManagerDelegate: RNAppAuthAuthorizationFlowManagerDelegate?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    FirebaseApp.configure()

    // Installed before notifee and React Native Firebase, which hook in on
    // UIApplicationDidFinishLaunchingNotification (after this method returns). Both wrap this
    // delegate and forward notifications they do not own (raw APNs pages) down to it.
    UNUserNotificationCenter.current().delegate = self

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "Boxalarm",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }

  func application(
    _ application: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    if let authorizationFlowManagerDelegate = self.authorizationFlowManagerDelegate,
       authorizationFlowManagerDelegate.resumeExternalUserAgentFlow(with: url) {
      return true
    }
    return false
  }
}

/// NSUserDefaults key the JS router reads through React Native's Settings API
/// (src/features/alerts/pushRouting.ts, IOS_PENDING_ALERT_TAP_KEY).
let pendingAlertTapKey = "boxalarm.pendingAlertTap"

// Dispatch notifications. Our pages come straight from APNs, with no FCM marker, so React
// Native Firebase neither chooses their foreground presentation nor reports taps on them.
// Mirrors the app's fail-loud rule (pushChannel.ts): anything but an explicit `digest` is a
// dispatch.
// Requires device verification: foreground presentation, plus taps from cold start,
// background and foreground.
extension AppDelegate {
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let category = notification.request.content.userInfo["category"] as? String
    completionHandler(category == "digest" ? [.banner, .list] : [.banner, .list, .sound])
  }

  // A tap on a dispatch records its dispatchId for the JS router. It is read on launch (cold
  // start) and reported as a settings change while running (background/foreground), so the
  // member lands on the alert they need to answer.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
      (userInfo["category"] as? String) != "digest",
      let dispatchId = userInfo["dispatchId"] as? String,
      !dispatchId.isEmpty
    {
      UserDefaults.standard.set(
        ["dispatchId": dispatchId, "tappedAt": Date().timeIntervalSince1970],
        forKey: pendingAlertTapKey
      )
    }
    completionHandler()
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
