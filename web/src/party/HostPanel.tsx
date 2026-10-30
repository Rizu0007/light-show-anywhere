import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { HostParty } from "./useHost";

const ASSIGNABLE_LIGHTS = Array.from({ length: 30 }, (_, i) => i + 1);
const MAX_SPEAKER_DELAY_MS = 600;

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
  nameOf: (channel: number) => string;
  speakerDelayMs: number;
  onSpeakerDelay: (ms: number) => void;
}

export function HostPanel({ party, hasShow, nameOf, speakerDelayMs, onSpeakerDelay }: Props) {
  const [qr, setQr] = useState<string | null>(null);
  const joinUrl = party.room ? `${location.origin}/join?room=${party.room}` : null;
  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  const heard = party.calibration?.heard ?? [];
  const measured = heard.flatMap((h) => (h.delayMs === null ? [] : [h.delayMs]));
  const suggestion = suggestedDelay(measured);

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
        <h3>Phones ({party.roster.length})</h3>
        {party.roster.length === 0 && <p className="hint">Waiting for phones to join…</p>}
        <ul>
          {party.roster.map((member, i) => (
            <li key={member.id}>
              <span>
                {member.name ?? `Phone ${i + 1}`}
                {!member.online && <em className="offline"> · offline</em>}
              </span>
              <select
                value={member.channel ?? ""}
                onChange={(e) => party.assign(member.id, e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Auto</option>
                {ASSIGNABLE_LIGHTS.map((channel) => (
                  <option key={channel} value={channel}>
                    {nameOf(channel)}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
