# Real-phone party test

Phase 4 is done when a party with real phones works. Automated tests cover the server and
headless Chrome; this checklist covers what only real phones, real Wi-Fi and a real speaker can
show. It takes about 20 minutes.

## You need

- The host computer, plugged in, on the same Wi-Fi as the phones.
- At least 4 phones: some iPhones and some Android phones if you can.
- The speaker you will use at the party (a Bluetooth one if that is the plan).
- A show and its song: `scripts/fetch-tesla-example.sh` downloads Tesla's example 1, whose
  song is `lightshow.wav` next to the `.fseq`.

## Start

```bash
(cd web && npm install && npm run build)
cargo run --release -p lsa-server -- --tls --static web/dist
```

Open the **https://** network address it prints on the host computer, accept the certificate
warning, load the show and song, and press **Start party**.

## Checks

Note the result of each check. The host's **Phones** list shows each phone's round trip
and any problems in yellow (clock not synced, slow Wi-Fi, not HTTPS, screen may sleep, can't
keep screen awake, no flashlight, reconnected more than twice).

| # | Do | Pass when |
|---|----|-----------|
| 1 | Every phone scans the QR code, accepts the certificate warning once and taps **Join** (tick *flashlight* on Android, *Help tune the sound* on two phones). | Each phone shows its light's name and "synced". The host lists every phone with no yellow, round trips under 150 ms. |
| 2 | Leave the phones untouched for 3 minutes, show paused. | No phone's screen turns off. (Screen kept awake.) |
| 3 | Press **Play** and watch the phones next to each other. | Phones on the same light change together; no visible lag between them. |
| 4 | Android phones with the flashlight ticked. | The flashlight follows the light. A phone without one shows "no flashlight" on the host. |
| 5 | Pause. **Measure speaker delay**, then **Use … ms**. Play again. | Both listening phones heard the tones; the measurements are within ~20 ms of each other; after applying, the song and lights feel together. |
| 6 | During playback, lock one phone's screen for 30 s, then unlock it. | It shows "reconnecting…" at most briefly, then plays in step with the others. Its screen stays on again afterwards: no "screen may sleep" for it on the host. |
| 7 | During playback, turn Wi-Fi off on one phone for 20 s, then on. | It keeps playing while offline, then reconnects; the host shows it offline, then back on the same light without a warning (only more than two reconnects are flagged). |
| 8 | Reload the page on one phone. | It gets the same light back. |
| 9 | During playback, turn the host computer's Wi-Fi off for 20 s, then on. (Keep the tab open: a closed or reloaded host tab cannot take the room back.) | Phones keep playing meanwhile; the host shows "Reconnecting…", then takes the room back with the same phones. |
| 10 | Press **End party**. | Every phone shows "Show over". |

## Report

For each check: pass or fail, the phone models and browsers, and for failures what the phone
and the host's **Phones** list showed. Round trips and the speaker measurements are useful
numbers to keep.
