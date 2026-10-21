/** Expo push: ask permission, register the token with the API, and deep-link a tapped notification to its task. */
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { api } from "./api";

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true }) });

export async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) return null;
  const { status: existing } = await Notifications.getPermissionsAsync();
  const status = existing === "granted" ? existing : (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return null;
  if (Platform.OS === "android") await Notifications.setNotificationChannelAsync("tasks", { name: "Tasks", importance: Notifications.AndroidImportance.HIGH });
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
  await api("/devices", { method: "POST", body: JSON.stringify({ push_token: token, platform: Platform.OS }) }).catch(() => {});
  return token;
}

/** Returns an unsubscribe; `onTask` receives the task id from the notification payload. */
export function onNotificationTap(onTask: (taskId: string, module?: string) => void) {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => { const d: any = r.notification.request.content.data ?? {}; if (d.task_id) onTask(String(d.task_id), d.module); });
  return () => sub.remove();
}
