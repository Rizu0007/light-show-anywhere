import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { PhoneHealth } from "./connection";
import type { Spot } from "./layouts";
import type { HostParty } from "./useHost";

const ASSIGNABLE_LIGHTS = Array.from({ length: 30 }, (_, i) => i + 1);
const MAX_SPEAKER_DELAY_MS = 600;

/** Round trips above this make a phone's clock (and light) less reliable. */
const SLOW_RTT_MS = 150;
/** More reconnects than this suggest weak Wi-Fi where the phone stands. */
const MANY_RECONNECTS = 2;

/** What could make this phone play badly, in words for the host. */
function problems(health: PhoneHealth | null): string[] {
  if (!health) return [];
  const found: string[] = [];
  if (!health.synced) found.push("clock not synced");
  if (health.rttMs !== null && health.rttMs > SLOW_RTT_MS) found.push(`slow Wi-Fi (${health.rttMs} ms)`);
  if (!health.secure) found.push("not HTTPS");
  else if (health.awake === false) found.push("screen may sleep");
  else if (health.awake === null) found.push("can't keep screen awake");
  if (health.torch === false) found.push("no flashlight");
  if (health.reconnects > MANY_RECONNECTS) found.push(`reconnected ${health.reconnects}×`);
  return found;
}

/** Median of the phones' measurements, rounded to the slider's 10 ms steps. */
function suggestedDelay(delays: number[]): number | null {
  if (delays.length === 0) return null;
  const sorted = [...delays].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.min(MAX_SPEAKER_DELAY_MS, Math.max(0, Math.round(median / 10) * 10));
}

interface Props {
  party: HostParty;
  hasShow: boolean;
  /** Cars in the loaded show (1 unless it is a fleet show). */
  cars: number;
  /** Where phones stand; empty for the car shape. */
  layout: Spot[];
  nameOf: (channel: number) => string;
  speakerDelayMs: number;
  onSpeakerDelay: (ms: number) => void;
}

export function HostPanel({ party, hasShow, cars, layout, nameOf, speakerDelayMs, onSpeakerDelay }: Props) {
  const [qr, setQr] = useState<string | null>(null);
  const joinUrl = party.room ? `${location.origin}/join?room=${party.room}` : null;
  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  const heard = party.calibration?.heard ?? [];
  const measured = heard.flatMap((h) => (h.delayMs === null ? [] : [h.delayMs]));
  const suggestion = suggestedDelay(measured);
  const troubled = party.roster.filter((m) => m.online && problems(m.health).length > 0).length;

  useEffect(() => {
    if (!joinUrl) {
      setQr(null);
      return;
    }
    QRCode.toDataURL(joinUrl, { margin: 1, width: 240 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [joinUrl]);

  if (!party.active) {
    return (
      <section className="party">
        <div>
          <h2>Party mode</h2>
          <p className="hint">
            Friends scan a QR code and each phone becomes one light of the car. For safety, phones flash at most 3
            times a second, so fast strobes look calmer than in the preview above.
          </p>
        </div>
        <button onClick={party.start} disabled={!hasShow}>
          Start party
        </button>
      </section>
    );
  }

  return (
    <section className="party active">
      <div className="party-join">
        {qr && <img src={qr} alt={`QR code to join room ${party.room}`} width={180} height={180} />}
        <div>
          <h2>
            Room <span className="room-code">{party.room ?? "…"}</span>
          </h2>
          {joinUrl && <code className="join-url">{joinUrl}</code>}
          <p className="hint">
            {party.connected
              ? party.synced
                ? "Connected · clock synced"
                : "Connected · syncing clock…"
              : party.room
                ? "Reconnecting… phones keep playing"
                : "Connecting…"}
          </p>
          {isLocalhost && (
            <p className="warn">
              Phones can't reach “localhost”. Open this page with your computer's network address (shown by the dev
              server, e.g. http://192.168.1.20:5173) before sharing the QR code.
            </p>
          )}
          {!isLocalhost && !window.isSecureContext && (
            <p className="warn">
              This page is not on HTTPS, so phones can't keep their screens awake or use the flashlight. Start the
              server with <code>--tls</code> and open the https:// address it prints.
            </p>
          )}
          {party.error && <p className="error">{party.error}</p>}
          <label className="delay">
            <span>Speaker delay: {speakerDelayMs} ms</span>
            <input
              type="range"
              min={0}
              max={MAX_SPEAKER_DELAY_MS}
              step={10}
              value={speakerDelayMs}
              onChange={(e) => onSpeakerDelay(Number(e.target.value))}
            />
          </label>
          <div className="calibrate">
            <button
              className="secondary"
              onClick={party.calibrate}
              disabled={!party.synced || party.playback.playing}
              title="Plays five short tones through this computer's speaker"
            >
              Measure speaker delay
            </button>
            {suggestion !== null && suggestion !== speakerDelayMs && (
              <button onClick={() => onSpeakerDelay(suggestion)}>Use {suggestion} ms</button>
            )}
          </div>
          <p className="hint">
            {!party.calibration
              ? "Phones with “Help tune the sound” on listen to tones from the speaker you'll use for the song."
              : heard.length === 0
                ? "Playing tones… phones are listening."
                : `${measured.length} of ${heard.length} listening phones heard the tones` +
                  (measured.length > 0
                    ? ` (${Math.round(Math.min(...measured))}–${Math.round(Math.max(...measured))} ms).`
                    : ". Turn the speaker up and try again.")}
          </p>
          <button className="secondary" onClick={party.stop}>
            End party
          </button>
        </div>
      </div>

      <div className="roster">
        <h3>
          Phones ({party.roster.length})
          {troubled > 0 && <span className="trouble"> · {troubled} with problems</span>}
        </h3>
        {party.roster.length === 0 && <p className="hint">Waiting for phones to join…</p>}
        <ul>
          {party.roster.map((member, i) => (
            <li key={member.id}>
              <span>
                {member.name ?? `Phone ${i + 1}`}
                {!member.online && <em className="offline"> · offline</em>}
                {member.online && problems(member.health).length > 0 && (
                  <em className="trouble"> · {problems(member.health).join(", ")}</em>
                )}
                {member.online && member.health?.rttMs != null && (
                  <small className="rtt"> {member.health.rttMs} ms</small>
                )}
              </span>
              {layout.length > 0 ? (
                <select
                  value={member.spot ?? ""}
                  onChange={(e) => party.assignSpot(member.id, e.target.value === "" ? null : Number(e.target.value))}
                >
                  <option value="">Any place</option>
                  {layout.map((spot, place) => (
                    <option key={place} value={place}>
                      Place {place + 1} · {cars > 1 ? `Car ${spot.car} · ` : ""}
                      {nameOf(spot.channel)}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={member.channel === null ? "" : `${member.car ?? 1}:${member.channel}`}
                  onChange={(e) => {
                    const [car, channel] = e.target.value.split(":").map(Number);
                    party.assign(member.id, car || 1, e.target.value ? channel : null);
                  }}
                >
                  <option value="">Auto</option>
                  {Array.from({ length: cars }, (_, i) => i + 1).map((car) => {
                    const options = ASSIGNABLE_LIGHTS.map((channel) => (
                      <option key={channel} value={`${car}:${channel}`}>
                        {nameOf(channel)}
                      </option>
                    ));
                    return cars > 1 ? (
                      <optgroup key={car} label={`Car ${car}`}>
                        {options}
                      </optgroup>
                    ) : (
                      options
                    );
                  })}
                </select>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
