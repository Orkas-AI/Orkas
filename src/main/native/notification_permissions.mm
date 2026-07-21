#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

#include <node_api.h>

#include <stdio.h>

namespace {

struct PermissionQuery {
  napi_deferred deferred;
  napi_async_work work;
  char state[24];
};

const char* permissionState(NSInteger authorizationStatus) {
  switch (authorizationStatus) {
    case 0: return "not_determined";
    case 1: return "denied";
    case 2: return "granted";
    // Provisional and ephemeral authorization can both deliver notifications.
    case 3:
    case 4: return "granted";
    default: return "unknown";
  }
}

void executePermissionQuery(napi_env, void* data) {
  PermissionQuery* query = static_cast<PermissionQuery*>(data);
  @autoreleasepool {
    NSBundle* bundle = [NSBundle mainBundle];
    if (bundle.bundleIdentifier.length == 0 || ![bundle.bundleURL.pathExtension isEqualToString:@"app"]) {
      snprintf(query->state, sizeof(query->state), "%s", "unknown");
      return;
    }
    @try {
      dispatch_semaphore_t completed = dispatch_semaphore_create(0);
      __block NSString* resolvedState = @"unknown";
      [[UNUserNotificationCenter currentNotificationCenter]
        getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
          resolvedState = [NSString stringWithUTF8String:
            permissionState(static_cast<NSInteger>(settings.authorizationStatus))];
          dispatch_semaphore_signal(completed);
        }];

      const dispatch_time_t deadline = dispatch_time(
        DISPATCH_TIME_NOW,
        static_cast<int64_t>(2) * NSEC_PER_SEC
      );
      if (dispatch_semaphore_wait(completed, deadline) == 0) {
        snprintf(query->state, sizeof(query->state), "%s", resolvedState.UTF8String);
      }
    } @catch (NSException*) {
      // If the framework rejects the current application context, keep the UI
      // non-authoritative instead of crashing the Electron main process.
      snprintf(query->state, sizeof(query->state), "%s", "unknown");
    }
  }
}

void completePermissionQuery(napi_env env, napi_status status, void* data) {
  PermissionQuery* query = static_cast<PermissionQuery*>(data);
  const char* result = status == napi_ok ? query->state : "unknown";
  napi_value value;
  napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &value);
  napi_resolve_deferred(env, query->deferred, value);
  napi_delete_async_work(env, query->work);
  delete query;
}

napi_value getPermissionState(napi_env env, napi_callback_info) {
  PermissionQuery* query = new PermissionQuery{
    nullptr,
    nullptr,
    "unknown",
  };

  napi_value promise;
  if (napi_create_promise(env, &query->deferred, &promise) != napi_ok) {
    delete query;
    return nullptr;
  }

  napi_value resourceName;
  napi_create_string_utf8(
    env,
    "orkas.notificationPermission",
    NAPI_AUTO_LENGTH,
    &resourceName
  );
  if (napi_create_async_work(
        env,
        nullptr,
        resourceName,
        executePermissionQuery,
        completePermissionQuery,
        query,
        &query->work
      ) != napi_ok || napi_queue_async_work(env, query->work) != napi_ok) {
    napi_value fallback;
    napi_create_string_utf8(env, "unknown", NAPI_AUTO_LENGTH, &fallback);
    napi_resolve_deferred(env, query->deferred, fallback);
    if (query->work) napi_delete_async_work(env, query->work);
    delete query;
  }

  return promise;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {
      "getPermissionState",
      nullptr,
      getPermissionState,
      nullptr,
      nullptr,
      nullptr,
      napi_default,
      nullptr,
    },
  };
  napi_define_properties(
    env,
    exports,
    sizeof(properties) / sizeof(properties[0]),
    properties
  );
  return exports;
}
