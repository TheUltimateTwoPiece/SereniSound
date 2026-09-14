"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "../lib/supabase-browser";

type DeviceStatus = {
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

declare global {
  interface Window {
    google?: any;
    initCaregiverMap?: () => void;
  }
}

const OFFLINE_AFTER_MS = 10_000;
const emptyStatus: DeviceStatus = {
  device_id: "pwd-001", latitude: null, longitude: null, address: null,
  location_source: "NONE", location_accuracy: null, current_track: 0,
  total_tracks: 0, is_playing: false, volume: 0, heart_rate: null,
  device_powered_on: true,
  updated_at: "",
};

function formatAge(updatedAt: string, now: number) {
  if (!updatedAt) return "Waiting for first update";
  const seconds = Math.max(0, Math.floor((now - new Date(updatedAt).getTime()) / 1000));
  if (seconds < 2) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s ago`;
}

function formatAccuracy(value: number | null) {
  return value === null || value <= 0 ? "Not reported" : `±${Math.round(value)} m`;
}

export default function Dashboard() {
  const [status, setStatus] = useState<DeviceStatus>(emptyStatus);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [trackToPlay, setTrackToPlay] = useState(1);
  const mapElement = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const infoWindowRef = useRef<any>(null);

  const isPoweredOn = status.device_powered_on !== false;
  const isOnline = isPoweredOn && Boolean(status.updated_at) && now - new Date(status.updated_at).getTime() <= OFFLINE_AFTER_MS;
  const age = formatAge(status.updated_at, now);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/device/status", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load device status");
      const result = await response.json();
      if (result.data) setStatus(result.data);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load device status");
    }
  }, []);

  const sendCommand = useCallback(async (command: "play_pause" | "next_track" | "previous_track" | "play_track", track?: number) => {
    setCommandBusy(true);
    try {
      const response = await fetch("/api/device/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: "pwd-001", command, ...(track === undefined ? {} : { track }) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to queue music command");
      setError(null);
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : "Unable to queue music command");
    } finally {
      setCommandBusy(false);
    }
  }, []);

  const infoContent = useMemo(() => {
    if (status.latitude === null || status.longitude === null) return "<strong>PWD</strong><br>Location unavailable";
    return `<strong>PWD</strong><br>${status.address || "Address unavailable"}<br><br>${status.latitude.toFixed(6)}, ${status.longitude.toFixed(6)}<br>${status.location_source || "NONE"} · ${formatAccuracy(status.location_accuracy)}`;
  }, [status]);

  const updateMap = useCallback((next: DeviceStatus) => {
    if (!mapRef.current || !window.google || next.latitude === null || next.longitude === null) return;
    const position = { lat: next.latitude, lng: next.longitude };
    if (!markerRef.current) {
      markerRef.current = new window.google.maps.Marker({ position, map: mapRef.current, title: "PWD" });
      infoWindowRef.current = new window.google.maps.InfoWindow();
      markerRef.current.addListener("click", () => {
        infoWindowRef.current?.setContent(infoContent);
        infoWindowRef.current?.open({ map: mapRef.current!, anchor: markerRef.current! });
      });
    } else {
      markerRef.current.setPosition(position);
    }
    mapRef.current.panTo(position);
  }, [infoContent]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void loadStatus();
    const refreshTimer = window.setInterval(() => { void loadStatus(); }, 5000);
    return () => window.clearInterval(refreshTimer);
  }, [loadStatus]);

  useEffect(() => {
    const client = supabaseBrowser;
    if (!client) return;
    const channel = client
      .channel("device-status-live")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "device_status", filter: "device_id=eq.pwd-001" }, (payload) => {
        setStatus(payload.new as DeviceStatus);
        setError(null);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "device_status", filter: "device_id=eq.pwd-001" }, (payload) => {
        setStatus(payload.new as DeviceStatus);
        setError(null);
      })
      .subscribe((subscriptionStatus) => {
        if (subscriptionStatus === "CHANNEL_ERROR" || subscriptionStatus === "TIMED_OUT") {
          setError("Realtime connection interrupted; five-second refresh is active.");
        }
      });
    return () => { void client.removeChannel(channel); };
  }, []);

  useEffect(() => {
    if (!mapElement.current || mapRef.current || !process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) return;
    const scriptId = "google-maps-script";
    const initialize = () => {
      if (!mapElement.current || !window.google) return;
      mapRef.current = new window.google.maps.Map(mapElement.current, {
        center: { lat: 1.3521, lng: 103.8198 }, zoom: 13, mapTypeControl: false,
        streetViewControl: false, fullscreenControl: true, clickableIcons: false,
      });
      updateMap(status);
    };
    window.initCaregiverMap = initialize;
    const existing = document.getElementById(scriptId);
    if (existing) { if (window.google) initialize(); return; }
    const script = document.createElement("script");
    script.id = scriptId;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY)}&callback=initCaregiverMap`;
    script.async = true;
    script.defer = true;
    script.onerror = () => setError("Google Maps could not load. Check the browser key and API restrictions.");
    document.head.appendChild(script);
    return () => { window.initCaregiverMap = undefined; };
  }, [status, updateMap]);

  useEffect(() => { updateMap(status); }, [status, updateMap]);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">S</span><div><p className="eyebrow">SERENISOUND</p><h1>Caregiver Monitor</h1></div></div>
        <div className="device-summary"><span className={`status-dot ${isOnline ? "online" : "offline"}`} /> <span>{isPoweredOn ? (isOnline ? "ONLINE" : "OFFLINE") : "POWERED OFF"}</span><span className="divider" /> <strong>PWD-001</strong></div>
      </header>
      {error && <div className="notice" role="alert">{error}</div>}
      <section className="welcome-row"><div><p className="eyebrow">LIVE DEVICE OVERVIEW</p></div><div className="last-seen"><span>LAST UPDATE</span><strong>{age}</strong></div></section>
      <section className="main-grid">
        <article className="map-card"><div className="card-heading"><div><p className="eyebrow">CURRENT LOCATION</p><h3>{status.address || "Location awaiting update"}</h3></div><span className={`source-badge ${status.location_source === "WPS" ? "wps" : "gps"}`}>{status.location_source || "NONE"}</span></div><div className="map" ref={mapElement}><div className="map-fallback">{status.latitude === null ? "Waiting for wearable location…" : "Loading map…"}</div></div></article>
        <aside className="side-stack">
          <article className="card location-card"><CardTitle label="LOCATION DETAILS" icon="⌖" /><div className="metric-grid"><Metric label="LATITUDE" value={status.latitude === null ? "—" : status.latitude.toFixed(6)} /><Metric label="LONGITUDE" value={status.longitude === null ? "—" : status.longitude.toFixed(6)} /><Metric label="SOURCE" value={status.location_source || "—"} /><Metric label="ACCURACY" value={formatAccuracy(status.location_accuracy)} /></div></article>
          <article className="card device-card"><CardTitle label="DEVICE" icon="◉" /><div className="device-line"><span>Power</span><strong className={isPoweredOn ? "green" : "red"}>{isPoweredOn ? "On" : "Powered off"}</strong></div><div className="device-line"><span>Connection</span><strong className={isOnline ? "green" : "red"}>{isOnline ? "Online" : "Offline"}</strong></div><div className="device-line"><span>Last update</span><strong>{age}</strong></div><div className="device-line"><span>Location source</span><strong>{status.location_source || "—"}</strong></div></article>
        </aside>
      </section>
      <section className="cards-grid">
        <article className="card music-card"><CardTitle label="MUSIC" icon="♫" /><div className="music-status"><span className={`play-icon ${status.is_playing ? "active" : ""}`}>{status.is_playing ? "▶" : "Ⅱ"}</span><div><strong>{status.is_playing ? "PLAYING" : "PAUSED"}</strong><p>Track {status.current_track || "—"} of {status.total_tracks || "—"}</p></div></div><div className="progress"><span style={{ width: `${status.total_tracks ? Math.min(100, (status.current_track / status.total_tracks) * 100) : 0}%` }} /></div><div className="volume-row"><span>VOLUME</span><strong>{status.volume} <small>/ 30</small></strong></div><div className="music-controls"><button disabled={commandBusy || !isPoweredOn} onClick={() => void sendCommand("previous_track")}>Previous</button><button className="primary-button" disabled={commandBusy || !isPoweredOn} onClick={() => void sendCommand("play_pause")}>{status.is_playing ? "Pause" : "Play"}</button><button disabled={commandBusy || !isPoweredOn} onClick={() => void sendCommand("next_track")}>Next</button></div><div className="play-track-row"><input aria-label="Track number" type="number" min="1" max={status.total_tracks || 1} value={trackToPlay} disabled={!isPoweredOn} onChange={(event) => setTrackToPlay(Number(event.target.value))} /><button disabled={commandBusy || !isPoweredOn || !status.total_tracks} onClick={() => void sendCommand("play_track", trackToPlay)}>Play track</button></div></article>
        <article className="card heart-card"><CardTitle label="HEART RATE" icon="♥" /><div className="heart-value">{status.heart_rate === null ? "--" : status.heart_rate}<span>BPM</span></div><p className="muted">{status.heart_rate === null ? "Sensor not connected" : "Current reading"}</p><div className="sensor-state"><span className="status-dot neutral" /> No medical thresholds configured</div></article>
        <article className="card address-card"><CardTitle label="ADDRESS" icon="⌂" /><p className="address-text">{status.address || "The wearable has not reported an address yet."}</p><p className="muted">Address is supplied by the wearable&apos;s Google reverse-geocoding lookup.</p></article>
      </section>
      <footer>Prototype monitoring view · Data is refreshed in real time from Supabase</footer>
    </main>
  );
}

function CardTitle({ label, icon }: { label: string; icon: string }) { return <div className="card-title"><span className="card-icon">{icon}</span><p className="eyebrow">{label}</p></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }
