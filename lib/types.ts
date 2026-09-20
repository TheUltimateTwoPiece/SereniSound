export type DeviceStatus = {
  device_id: string;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  location_source: "GPS" | "WPS" | "NONE" | null;
  location_accuracy: number | null;
  current_track: number;
  total_tracks: number;
  is_playing: boolean;
  volume: number;
  heart_rate: number | null;
  device_powered_on: boolean;
  updated_at: string;
};

export type AlertSettings = {
  device_id: string;
  alerts_enabled: boolean;
  alert_email: string;
  geofence_enabled: boolean;
  zone_label: string;
  zone_latitude: number | null;
  zone_longitude: number | null;
  zone_radius_m: number;
  heart_rate_enabled: boolean;
  max_heart_rate: number;
  last_geofence_alert_at: string | null;
  last_heart_rate_alert_at: string | null;
  updated_at: string;
};

export type AlertKind = "geofence_exit" | "heart_rate_high" | "recovery" | "test";

export type EmailStatus = "sent" | "failed" | "skipped";

export type AlertRecord = {
  id: number;
  device_id: string;
  kind: AlertKind;
  message: string;
  detail: Record<string, string | number | null>;
  email_to: string | null;
  email_status: EmailStatus;
  email_error: string | null;
  is_test: boolean;
  created_at: string;
};

export type AlertEvent = {
  kind: AlertKind;
  severity: "warning" | "info";
  subject: string;
  headline: string;
  message: string;
  detail: Record<string, string | number | null>;
};

export const DEFAULT_ALERT_SETTINGS: Omit<AlertSettings, "device_id"> = {
  alerts_enabled: true,
  alert_email: "kakarla_hemanth_reddy@s2026.ssts.edu.sg",
  geofence_enabled: false,
  zone_label: "Home zone",
  zone_latitude: null,
  zone_longitude: null,
  zone_radius_m: 200,
  heart_rate_enabled: false,
  max_heart_rate: 120,
  last_geofence_alert_at: null,
  last_heart_rate_alert_at: null,
  updated_at: "",
};
