//! Party server: one WebSocket (`/ws`) per browser for clock sync, rooms, host commands and each
//! phone's [`safety`]-governed light track. Clock sync follows Crowd Light Show
//! (<https://github.com/AndriiShramko/crowd-light-show>, Apache-2.0).

pub mod lights;
pub mod protocol;
pub mod room;
pub mod safety;
pub mod tls;
pub mod wled;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tower_http::services::{ServeDir, ServeFile};

use crate::protocol::{ClientMsg, ServerMsg};
use crate::room::{MAX_SHOW_BYTES, MemberId, Outgoing, Rooms};

/// How long a dropped phone or host keeps its place: long enough for a phone to come back from
/// a locked screen or a Wi-Fi switch.
pub const RESUME_GRACE: Duration = Duration::from_secs(120);

/// Hosts get at most one roster per this interval, with every change since the last one.
pub const ROSTER_INTERVAL: Duration = Duration::from_millis(200);

/// Shared server state.
#[derive(Debug)]
pub struct AppState {
    rooms: Mutex<Rooms>,
    started: Instant,
    next_id: AtomicU64,
    resume_grace: Duration,
    /// A roster flush is waiting to run.
    roster_flush: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self::with_resume_grace(RESUME_GRACE)
    }
}

impl AppState {
    /// State whose dropped connections keep their place for `grace` (see [`RESUME_GRACE`]).
    #[must_use]
    pub fn with_resume_grace(grace: Duration) -> Self {
        Self {
            rooms: Mutex::default(),
            started: Instant::now(),
            next_id: AtomicU64::new(1),
            resume_grace: grace,
            roster_flush: AtomicBool::new(false),
        }
    }

    /// Server clock in milliseconds since start; the time base every client syncs to.
    #[must_use]
    pub fn now_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    fn rooms(&self) -> std::sync::MutexGuard<'_, Rooms> {
        // A panic while holding the lock leaves rooms usable; keep serving.
        self.rooms.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sends owed rosters after [`ROSTER_INTERVAL`], unless a send is already waiting (it will
    /// include this change).
    fn schedule_rosters(self: &Arc<Self>) {
        if !self.rooms().rosters_due() || self.roster_flush.swap(true, Ordering::AcqRel) {
            return;
        }
        let state = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(ROSTER_INTERVAL).await;
            // Cleared first: a change made during the flush schedules the next one.
            state.roster_flush.store(false, Ordering::Release);
            state.rooms().flush_rosters();
        });
    }
}

/// Builds the router. With `static_dir`, also serves the built web app (single-page fallback).
pub fn app(state: Arc<AppState>, static_dir: Option<PathBuf>) -> Router {
    let router = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(|| async { "ok" }))
        .with_state(state);
    match static_dir {
        Some(dir) => {
            let index = dir.join("index.html");
            router.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)))
        }
        None => router,
    }
}

/// Runs the server until Ctrl+C, over HTTPS when `tls` is given, driving WLED strips when
/// `wled` lists them.
pub async fn serve(
    addr: SocketAddr,
    static_dir: Option<PathBuf>,
    tls: Option<tls::Tls>,
    wled: Option<wled::Config>,
) -> std::io::Result<()> {
    let state = Arc::new(AppState::default());
    if let Some(config) = wled {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(err) = wled::run(state, config).await {
                tracing::error!("WLED output stopped: {err}");
            }
        });
    }
    let app = app(state, static_dir);
    let Some(tls) = tls else {
        let listener = tokio::net::TcpListener::bind(addr).await?;
        log_addresses("http", listener.local_addr()?);
        return axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await;
    };

    // Only one crypto provider is compiled in, so installing it cannot conflict.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let pem = tokio::task::spawn_blocking(move || tls.load())
        .await
        .map_err(std::io::Error::other)??;
    let config = axum_server::tls_rustls::RustlsConfig::from_pem(pem.cert, pem.key).await?;
    let handle = axum_server::Handle::new();
    let shutdown = handle.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown.graceful_shutdown(None);
    });
    let listening = handle.clone();
    tokio::spawn(async move {
        if let Some(addr) = listening.listening().await {
            log_addresses("https", addr);
        }
    });
    axum_server::bind_rustls(addr, config)
        .handle(handle)
        .serve(app.into_make_service())
        .await
}

/// Logs the addresses to open, with network addresses first when listening on all of them.
fn log_addresses(scheme: &str, addr: SocketAddr) {
    if addr.ip().is_unspecified() {
        for ip in tls::lan_addresses() {
            tracing::info!(
                "listening on {scheme}://{}",
                SocketAddr::new(ip, addr.port())
            );
        }
        tracing::info!("listening on {scheme}://localhost:{}", addr.port());
    } else {
        tracing::info!("listening on {scheme}://{addr}");
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> Response {
    ws.max_message_size(MAX_SHOW_BYTES + 1024)
        .on_upgrade(move |socket| connection(socket, state))
}

/// Pending upload: set by `Load`, consumed by the next binary frame.
struct PendingLoad {
    vehicle: String,
    name: String,
    sizes: Vec<u32>,
}

async fn connection(socket: WebSocket, state: Arc<AppState>) {
    // Who this connection speaks for: itself, until it resumes an earlier place.
    let mut id: MemberId = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();

    let writer = tokio::spawn(async move {
        while let Some(outgoing) = rx.recv().await {
            let message = match outgoing {
                Outgoing::Text(message) => match serde_json::to_string(&message) {
                    Ok(json) => Message::Text(json.into()),
                    Err(err) => {
                        tracing::error!("serialising {message:?}: {err}");
                        continue;
                    }
                },
                Outgoing::Binary(bytes) => Message::Binary(bytes.into()),
            };
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    let mut pending: Option<PendingLoad> = None;
    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Text(text) => match serde_json::from_str::<ClientMsg>(&text) {
                // The most frequent message, and it never changes a room.
                Ok(ClientMsg::Sync { c0 }) => {
                    let _ = tx.send(Outgoing::Text(ServerMsg::Sync {
                        c0,
                        s1: state.now_ms(),
                    }));
                    continue;
                }
                Ok(ClientMsg::Load {
                    vehicle,
                    name,
                    sizes,
                }) => {
                    pending = Some(PendingLoad {
                        vehicle,
                        name,
                        sizes,
                    });
                }
                Ok(ClientMsg::Resume { token }) => {
                    let mut rooms = state.rooms();
                    match rooms.resume(&token, tx.clone()) {
                        Some(resumed) => {
                            if resumed != id {
                                rooms.leave(id);
                            }
                            id = resumed;
                        }
                        None => {
                            let _ = tx.send(Outgoing::Text(ServerMsg::Expired));
                        }
                    }
                }
                Ok(command) => handle(&state, id, &tx, command),
                Err(err) => reply_error(&tx, format!("bad message: {err}")),
            },
            Message::Binary(bytes) => {
                let Some(load) = pending.take() else {
                    reply_error(&tx, "send a load message before the show file".into());
                    continue;
                };
                let result =
                    state
                        .rooms()
                        .load_show(id, &load.vehicle, &load.name, &bytes, &load.sizes);
                if let Err(message) = result {
                    reply_error(&tx, message);
                }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
        }
        state.schedule_rosters();
    }

    // Keep the place for a while in case the phone or host comes back. The room still holds a
    // sender for this connection, so stop the writer rather than wait for it; messages sent to
    // an offline place are then dropped.
    let epoch = state.rooms().disconnect(id, &tx);
    state.schedule_rosters();
    writer.abort();
    // Close the socket now; the browser waits for that before it reconnects.
    drop(stream);
    if let Some(epoch) = epoch {
        tokio::time::sleep(state.resume_grace).await;
        state.rooms().expire(id, epoch);
        state.schedule_rosters();
    }
}

fn handle(
    state: &AppState,
    id: MemberId,
    tx: &mpsc::UnboundedSender<Outgoing>,
    command: ClientMsg,
) {
    let now = state.now_ms();
    let result = match command {
        ClientMsg::Create => state.rooms().create(id, tx.clone()).map(|_| ()),
        ClientMsg::Join { room, name } => state.rooms().join(id, &room, name, tx.clone()),
        ClientMsg::Play { position_ms } => state.rooms().play(id, position_ms, now),
        ClientMsg::Pause => state.rooms().pause(id, now),
        ClientMsg::Seek { position_ms } => state.rooms().seek(id, position_ms, now),
        ClientMsg::Assign {
            member,
            channel,
            car,
            spot,
        } => {
            let slot = channel.map(|channel| room::Slot {
                car: car.unwrap_or(1),
                channel,
            });
            state.rooms().assign(id, member, slot, spot)
        }
        ClientMsg::Layout { spots } => state.rooms().set_layout(id, spots),
        ClientMsg::Calibrate => state.rooms().calibrate(id, now),
        ClientMsg::Heard { delay_ms } => state.rooms().heard(id, delay_ms),
        ClientMsg::Status(health) => state.rooms().status(id, health),
        ClientMsg::Leave => {
            state.rooms().leave(id);
            Ok(())
        }
        ClientMsg::Sync { .. } | ClientMsg::Load { .. } | ClientMsg::Resume { .. } => {
            unreachable!("handled by the connection loop")
        }
    };
    if let Err(message) = result {
        reply_error(tx, message);
    }
}

fn reply_error(tx: &mpsc::UnboundedSender<Outgoing>, message: String) {
    let _ = tx.send(Outgoing::Text(ServerMsg::Error { message }));
}
