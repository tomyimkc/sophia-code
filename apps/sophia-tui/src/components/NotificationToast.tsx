import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";

import type { NotificationRequest } from "../lib/notifications.js";
import {
  notificationAnnouncement,
  sanitizeNotificationText,
  truncateTerminalText,
} from "../lib/notifications.js";
import type { TerminalCapabilities } from "../lib/terminalCapabilities.js";
import type { Theme } from "../lib/theme.js";
import { accessibleTheme } from "../lib/accessibility.js";
import { MatrixText } from "./MatrixText.js";

export interface NotificationToastViewModel {
  marker: string;
  title: string;
  body: string;
  announcement: string;
  showBodyLine: boolean;
  borderStyle: "round" | undefined;
}

function notificationMarker(
  request: NotificationRequest,
  capabilities: TerminalCapabilities,
): string {
  if (capabilities.accessibility.screenReader) return "Notification:";
  if (!capabilities.unicode) {
    return request.kind === "error"
      ? "[!]"
      : request.kind === "warning"
        ? "[!]"
        : request.kind === "success"
          ? "[OK]"
          : "[i]";
  }
  if (request.kind === "error") return "✗";
  if (request.kind === "warning") return "⚠";
  if (request.kind === "success") return "✓";
  return "ℹ";
}

export function notificationToastBorderStyle(
  capabilities: TerminalCapabilities,
): "round" | undefined {
  return capabilities.accessibility.screenReader ? undefined : "round";
}

export function buildNotificationToastViewModel(
  request: NotificationRequest,
  capabilities: TerminalCapabilities,
  width: number,
): NotificationToastViewModel {
  const safeWidth = Number.isFinite(width) ? Math.max(20, Math.floor(width)) : 80;
  const marker = notificationMarker(request, capabilities);
  const title = sanitizeNotificationText(request.title) || "Sophia";
  const body = sanitizeNotificationText(request.body ?? "");
  const ellipsis = capabilities.unicode ? "…" : "...";
  const textBudget = Math.max(8, safeWidth - stringWidth(marker) - 5);
  const compact =
    capabilities.widthClass === "narrow" || capabilities.widthClass === "compact";

  if (compact && body) {
    const separator = capabilities.unicode ? " — " : " - ";
    return {
      marker,
      title: truncateTerminalText(`${title}${separator}${body}`, textBudget, ellipsis),
      body: "",
      announcement: notificationAnnouncement({ ...request, title, body }),
      showBodyLine: false,
      borderStyle: notificationToastBorderStyle(capabilities),
    };
  }

  return {
    marker,
    title: truncateTerminalText(title, textBudget, ellipsis),
    body: truncateTerminalText(body, Math.max(8, safeWidth - 4), ellipsis),
    announcement: notificationAnnouncement({ ...request, title, body }),
    showBodyLine: Boolean(body),
    borderStyle: notificationToastBorderStyle(capabilities),
  };
}

function toastColor(
  request: NotificationRequest,
  theme: Theme,
  capabilities: TerminalCapabilities,
): string {
  if (capabilities.accessibility.screenReader) return "";
  if (capabilities.accessibility.lowColor) return theme.text;
  if (request.kind === "error") return theme.error;
  if (request.kind === "warning") return theme.warn;
  if (request.kind === "success") return theme.success;
  return theme.accent;
}

/**
 * Toast lifetime remains owned by its controller. Its newly emitted wording
 * uses the shared Matrix scheduler, which starts no timer at all under reduced
 * motion/screen-reader preferences.
 */
export function NotificationToast({
  notification,
  capabilities,
  theme,
  width,
}: {
  notification: NotificationRequest;
  capabilities: TerminalCapabilities;
  theme: Theme;
  width: number;
}): React.ReactElement {
  const model = buildNotificationToastViewModel(notification, capabilities, width);
  const t = accessibleTheme(theme, capabilities.accessibility);
  const color = toastColor(notification, t, capabilities);

  return (
    <Box
      flexDirection="column"
      width={Math.max(20, width)}
      paddingX={1}
      borderStyle={model.borderStyle}
      borderColor={model.borderStyle ? color : undefined}
    >
      <Text color={color} bold>
        {model.marker}{" "}
        <MatrixText text={model.title} animateOnMount seed={907} />
      </Text>
      {model.showBodyLine ? (
        <Text color={t.text}>
          <MatrixText text={model.body} animateOnMount seed={919} />
        </Text>
      ) : null}
    </Box>
  );
}
