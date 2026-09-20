"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDistance, haversineMeters } from "../lib/geo";
import type { AlertRecord, AlertSettings, DeviceStatus } from "../lib/types";

export type SafetyOverlay = {
  zone: { label: string; enabled: boolean; latitude: number | null; longitude: number | null; radiusM: number };
  heartRate: { enabled: boolean; limit: number };
};

type Scenario = "zone_exit" | "heart_rate" | "test_email" | "safe_return" | "clear_history";
type DemoResult = { tone: "success" | "warning" | "error"; message: string };

const DEMO_ACTIONS: { scenario: Scenario; label: string; hint: string; tone: "primary" | "plain" | "danger" }[] = [
  { scenario: "zone_exit", label: "Zone breach warning", hint: "Simulated position outside the zone", tone: "primary" },
  { scenario: "heart_rate", label: "Heart-rate warning", hint: "Simulated reading above the limit", tone: "plain" },
  { scenario: "test_email", label: "Send test email", hint: "Checks Brevo delivery only", tone: "plain" },
  { scenario: "safe_return", label: "Mark safe again", hint: "Clears the warning state", tone: "plain" },
  { scenario: "clear_history", label: "Clear history", hint: "Resets the demo log", tone: "danger" },
];

const KIND_LABELS: Record<AlertRecord["kind"], string> = {
  geofence_exit: "ZONE",
  heart_rate_high: "HEART",
  recovery: "SAFE",
  test: "TEST",
};

function stamp(createdAt: string) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function SafetyPanel({
  status,
  onSafetyChange,
}: {
  status: DeviceStatus;
  onSafetyChange: (overlay: SafetyOverlay | null) => void;
}) {
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [draft, setDraft] = useState<AlertSettings | null>(null);
  const [history, setHistory] = useState<AlertRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<Scenario | null>(null);
  const [demoResult, setDemoResult] = useState<DemoResult | null>(null);
  // Tracks whether the form has ever been populated, so a failed first load can recover.
  const hasDraft = useRef(false);

  const dirty = useMemo(
    () => Boolean(settings && draft) && JSON.stringify(settings) !== JSON.stringify(draft),
    [settings, draft],
  );

  const applySafety = useCallback((next: AlertSettings | null) => {
    if (!next) return onSafetyChange(null);
    onSafetyChange({
      zone: {
        label: next.zone_label,
        enabled: next.geofence_enabled,
        latitude: next.zone_latitude,
        longitude: next.zone_longitude,
        radiusM: next.zone_radius_m || 0,
      },
      heartRate: { enabled: next.heart_rate_enabled, limit: next.max_heart_rate },
    });
  }, [onSafetyChange]);

  const load = useCallback(async (options: { keepDraft: boolean }) => {
    try {
      const response = await fetch("/api/alerts/settings", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to load alert settings");
      setHistory(Array.isArray(result.history) ? result.history : []);
      setSettings(result.settings);
      if (!options.keepDraft || !hasDraft.current) {
        setDraft(result.settings);
        applySafety(result.settings);
        hasDraft.current = true;
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load alert settings");
    }
  }, [applySafety]);

  useEffect(() => { void load({ keepDraft: false }); }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => { void load({ keepDraft: true }); }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  // Keep the map overlay in step with the values being edited.
  useEffect(() => { applySafety(draft); }, [draft, applySafety]);

  const distance = useMemo(() => {
    if (!draft || status.latitude === null || status.longitude === null) return null;
    if (draft.zone_latitude === null || draft.zone_longitude === null) return null;
    return haversineMeters(
      { latitude: status.latitude, longitude: status.longitude },
      { latitude: draft.zone_latitude, longitude: draft.zone_longitude },
    );
  }, [draft, status.latitude, status.longitude]);

  const outsideZone = distance !== null && draft !== null && distance > draft.zone_radius_m;

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const response = await fetch("/api/alerts/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to save alert settings");
      setSettings(result.settings);
      setDraft(result.settings);
      setSaveMessage("Saved. Warnings now use these values.");
      setError(null);
    } catch (saveError) {
      setSaveMessage(saveError instanceof Error ? saveError.message : "Unable to save alert settings");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const useCurrentLocation = useCallback(() => {
    if (status.latitude === null || status.longitude === null) {
      setSaveMessage("The wearable has not reported a position yet.");
      return;
    }
    setDraft((current) => current && { ...current, zone_latitude: status.latitude, zone_longitude: status.longitude });
  }, [status.latitude, status.longitude]);

  const runDemo = useCallback(async (scenario: Scenario) => {
    setRunning(scenario);
    setDemoResult(null);
    try {
      const response = await fetch("/api/alerts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to run the demo");
      if (Array.isArray(result.history)) setHistory(result.history);
      const email = result.email as { status: string; error: string | null } | undefined;
      const target = settings?.alert_email ?? "the caregiver inbox";
      if (email?.status === "sent") {
        setDemoResult({ tone: "success", message: `${result.message} Email delivered to ${target}.` });
      } else if (email?.status === "failed") {
        setDemoResult({ tone: "error", message: `Warning recorded, but the email failed: ${email.error}` });
      } else if (email?.status === "skipped" && scenario !== "clear_history") {
        setDemoResult({ tone: "warning", message: `Recorded without sending email: ${email.error ?? "no email sent"}` });
      } else {
        setDemoResult({ tone: "success", message: result.message });
      }
    } catch (demoError) {
      setDemoResult({ tone: "error", message: demoError instanceof Error ? demoError.message : "Unable to run the demo" });
    } finally {
      setRunning(null);
    }
  }, [settings?.alert_email]);

  return (
    <section className="safety-grid">
      <article className="card zone-card">
        <CardTitle label="SAFETY ZONE & WARNINGS" icon="⬡" />
        {!draft ? (
          <p className="muted">{error ?? "Loading alert settings…"}</p>
        ) : (
          <>
            <div className={`zone-state ${outsideZone ? "breach" : draft.geofence_enabled ? "inside" : "off"}`}>
              <strong>
                {!draft.geofence_enabled
                  ? "Zone warnings off"
                  : outsideZone
                    ? "OUTSIDE THE ZONE"
                    : "Inside the zone"}
              </strong>
              <span>
                {status.latitude === null ? "Wearable position unavailable" : `Wearable is ${formatDistance(distance)} from the centre`}
                {` · limit ${formatDistance(draft.zone_radius_m)}`}
              </span>
            </div>

            <label className="field">
              <span>WARNING EMAIL</span>
              <input
                type="email"
                value={draft.alert_email}
                onChange={(event) => setDraft({ ...draft, alert_email: event.target.value })}
              />
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={draft.geofence_enabled}
                onChange={(event) => setDraft({ ...draft, geofence_enabled: event.target.checked })}
              />
              <span>Email me when the PWD leaves the zone</span>
            </label>

            <div className="field-grid">
              <label className="field">
                <span>ZONE NAME</span>
                <input value={draft.zone_label} onChange={(event) => setDraft({ ...draft, zone_label: event.target.value })} />
              </label>
              <label className="field">
                <span>RADIUS (M)</span>
                <input
                  type="number"
                  min={25}
                  max={50000}
                  value={draft.zone_radius_m}
                  onChange={(event) => setDraft({ ...draft, zone_radius_m: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span>CENTRE LATITUDE</span>
                <input
                  type="number"
                  step="0.000001"
                  value={draft.zone_latitude ?? ""}
                  placeholder="Not set"
                  onChange={(event) => setDraft({ ...draft, zone_latitude: event.target.value === "" ? null : Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span>CENTRE LONGITUDE</span>
                <input
                  type="number"
                  step="0.000001"
                  value={draft.zone_longitude ?? ""}
                  placeholder="Not set"
                  onChange={(event) => setDraft({ ...draft, zone_longitude: event.target.value === "" ? null : Number(event.target.value) })}
                />
              </label>
            </div>
            <button className="panel-button plain full" type="button" onClick={useCurrentLocation} disabled={status.latitude === null}>
              Use the wearable&apos;s current position as the centre
            </button>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={draft.heart_rate_enabled}
                onChange={(event) => setDraft({ ...draft, heart_rate_enabled: event.target.checked })}
              />
              <span>Email me when the heart rate is too high</span>
            </label>
            <div className="field-grid">
              <label className="field">
                <span>HEART RATE LIMIT (BPM)</span>
                <input
                  type="number"
                  min={40}
                  max={250}
                  value={draft.max_heart_rate}
                  onChange={(event) => setDraft({ ...draft, max_heart_rate: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span>CURRENT READING</span>
                <input value={status.heart_rate === null ? "Sensor not connected" : `${status.heart_rate} bpm`} readOnly />
              </label>
            </div>

            <label className="toggle-row master">
              <input
                type="checkbox"
                checked={draft.alerts_enabled}
                onChange={(event) => setDraft({ ...draft, alerts_enabled: event.target.checked })}
              />
              <span>All warning emails enabled</span>
            </label>

            <div className="panel-actions">
              <button className="panel-button primary" type="button" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? "Saving…" : dirty ? "Save zone & limits" : "Saved"}
              </button>
              <button
                className="panel-button plain"
                type="button"
                onClick={() => { if (settings) { setDraft(settings); setSaveMessage(null); } }}
                disabled={!dirty}
              >
                Undo changes
              </button>
            </div>
            {saveMessage && <p className="panel-message">{saveMessage}</p>}
          </>
        )}
      </article>

      <article className="card demo-card">
        <CardTitle label="FEATURE DEMO PANEL" icon="▶" />
        <p className="muted">
          Each button runs the real detection and email code against invented readings, so you can show every warning
          live without moving the wearable. Demo emails are marked <strong>[DEMO]</strong> and ignore the five-minute
          warning cooldown.
        </p>
        <div className="demo-list">
          {DEMO_ACTIONS.map((action) => (
            <button
              key={action.scenario}
              type="button"
              className={`demo-action ${action.tone}`}
              onClick={() => void runDemo(action.scenario)}
              disabled={running !== null}
            >
              <strong>{running === action.scenario ? "Running…" : action.label}</strong>
              <span>{action.hint}</span>
            </button>
          ))}
        </div>
        {demoResult && <p className={`demo-result ${demoResult.tone}`}>{demoResult.message}</p>}
        {error && <p className="demo-result error">{error}</p>}
      </article>

      <article className="card history-card">
        <CardTitle label="WARNING HISTORY" icon="⏱" />
        {history.length === 0 ? (
          <p className="muted">No warnings yet. Use the demo panel to run one.</p>
        ) : (
          <ul className="history-list">
            {history.slice(0, 8).map((entry) => (
              <li key={entry.id}>
                <div className="history-head">
                  <span className={`kind-badge ${entry.kind}`}>{KIND_LABELS[entry.kind]}</span>
                  <strong>{stamp(entry.created_at)}</strong>
                  <span className={`email-badge ${entry.email_status}`}>{entry.email_status.toUpperCase()}</span>
                </div>
                <p>{entry.message}</p>
                {entry.email_error && <small>{entry.email_error}</small>}
              </li>
            ))}
          </ul>
        )}
      </article>
    </section>
  );
}

function CardTitle({ label, icon }: { label: string; icon: string }) {
  return <div className="card-title"><span className="card-icon">{icon}</span><p className="eyebrow">{label}</p></div>;
}
