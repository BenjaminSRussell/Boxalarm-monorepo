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

  // Whatever notification-center delegate was installed before ours (a library that hooked
  // in earlier). Everything except dispatch foreground presentation is forwarded to it, so
  // tap routing keeps working. Libraries that install later wrap us and forward here.
  var previousNotificationDelegate: UNUserNotificationCenterDelegate?

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

    let notificationCenter = UNUserNotificationCenter.current()
    previousNotificationDelegate = notificationCenter.delegate
    notificationCenter.delegate = self

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

// Foreground presentation of dispatch alerts. Our pages come straight from APNs, with no FCM
// marker, so React Native Firebase does not choose presentation options for them. Without
// this, a dispatch that arrives while Boxalarm is open would show nothing. Mirrors the app's
// fail-loud rule (pushChannel.ts): anything but an explicit `digest` is a dispatch.
// Requires device verification: foreground, locked, and in Sleep Focus.
extension AppDelegate {
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let category = notification.request.content.userInfo["category"] as? String
    if category != "digest" {
      completionHandler([.banner, .list, .sound])
      return
    }
    if let forward = previousNotificationDelegate?.userNotificationCenter(
      _:willPresent:withCompletionHandler:)
    {
      forward(center, notification, completionHandler)
      return
    }
    completionHandler([.banner, .list])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if let forward = previousNotificationDelegate?.userNotificationCenter(
      _:didReceive:withCompletionHandler:)
    {
      forward(center, response, completionHandler)
      return
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
