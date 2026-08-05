import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import type { NotificationContent, NotificationTap, NotificationTapNative, PushNative, PushPermission } from "./service.ts";

function permission(status: Notifications.PermissionStatus): PushPermission {
  return status === Notifications.PermissionStatus.GRANTED
    ? "granted"
    : status === Notifications.PermissionStatus.DENIED ? "denied" : "undetermined";
}

export function expoPushNative(projectId?: string): PushNative {
  if (Platform.OS !== "ios" && Platform.OS !== "android") throw new Error("push: unsupported platform");
  return {
    platform: Platform.OS,
    async permission() { return permission((await Notifications.getPermissionsAsync()).status); },
    async requestPermission() { return permission((await Notifications.requestPermissionsAsync()).status); },
    async expoToken() {
      const result = projectId === undefined
        ? await Notifications.getExpoPushTokenAsync()
        : await Notifications.getExpoPushTokenAsync({ projectId });
      return result.data;
    },
  };
}

export function onNotificationTap(listener: (content: NotificationContent) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const content = response.notification.request.content;
    listener({ title: content.title, body: content.body, subtitle: content.subtitle, data: content.data });
  });
  return () => subscription.remove();
}

function tap(response: Notifications.NotificationResponse): NotificationTap {
  const content = response.notification.request.content;
  return {
    id: response.notification.request.identifier,
    content: { title: content.title, body: content.body, subtitle: content.subtitle, data: content.data },
  };
}

export function expoNotificationTaps(): NotificationTapNative {
  return {
    async lastResponse() {
      const response = await Notifications.getLastNotificationResponseAsync();
      return response === null ? null : tap(response);
    },
    async clearLastResponse() { await Notifications.clearLastNotificationResponseAsync(); },
    listen(listener) {
      const subscription = Notifications.addNotificationResponseReceivedListener((response) => listener(tap(response)));
      return () => subscription.remove();
    },
  };
}
