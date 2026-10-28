//! Party server for Light Show Anywhere.
//!
//! One WebSocket (`/ws`) per browser carries clock sync, room membership, host commands, the
//! uploaded show and each phone's light track. The server renders shows with `lsa-tesla`, so a
//! phone downloads only its own light (one byte per frame) instead of the whole file.
//!
//! Clock sync follows the approach documented by Crowd Light Show
//! (<https://github.com/AndriiShramko/crowd-light-show>, Apache-2.0): clients ping, the server
//! stamps its clock, and clients keep the lowest-round-trip estimate.

pub mod lights;
pub mod protocol;
pub mod room;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

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

/// Shared server state.
#[derive(Debug)]
pub struct AppState {
    rooms: Mutex<Rooms>,
    started: Instant,
    next_id: AtomicU64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            rooms: Mutex::default(),
            started: Instant::now(),
            next_id: AtomicU64::new(1),
        }
    }
}

impl AppState {
    /// Server clock in milliseconds since start; the time base every client syncs to.
    #[must_use]
    pub fn now_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    fn rooms(&self) -> std::sync::MutexGuard<'_, Rooms> {
        // A panic while holding the lock leaves rooms usable; keep serving.
        self.rooms.lock().unwrap_or_else(PoisonError::into_inner)
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

/// Runs the server until Ctrl+C.
pub async fn serve(addr: SocketAddr, static_dir: Option<PathBuf>) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{}", listener.local_addr()?);
    axum::serve(listener, app(Arc::default(), static_dir))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> Response {
    ws.max_message_size(MAX_SHOW_BYTES + 1024)
        .on_upgrade(move |socket| connection(socket, state))
}

/// Pending upload: set by `Load`, consumed by the next binary frame.
struct PendingLoad {
    vehicle: String,
    name: String,
}

async fn connection(socket: WebSocket, state: Arc<AppState>) {
    let id: MemberId = state.next_id.fetch_add(1, Ordering::Relaxed);
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
                Ok(ClientMsg::Load { vehicle, name }) => {
                    pending = Some(PendingLoad { vehicle, name });
                }
                Ok(command) => handle(&state, id, &tx, command),
                Err(err) => reply_error(&tx, format!("bad message: {err}")),
            },
            Message::Binary(bytes) => {
                let Some(load) = pending.take() else {
                    reply_error(&tx, "send a load message before the show file".into());
                    continue;
                };
                let result = state
                    .rooms()
                    .load_show(id, &load.vehicle, &load.name, &bytes);
                if let Err(message) = result {
                    reply_error(&tx, message);
                }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }

    state.rooms().leave(id);
    drop(tx);
    let _ = writer.await;
}

fn handle(
    state: &AppState,
    id: MemberId,
    tx: &mpsc::UnboundedSender<Outgoing>,
    command: ClientMsg,
) {
    let now = state.now_ms();
    let result = match command {
        ClientMsg::Sync { c0 } => {
            let _ = tx.send(Outgoing::Text(ServerMsg::Sync { c0, s1: now }));
            Ok(())
        }
        ClientMsg::Create => {
            state.rooms().create(id, tx.clone());
            Ok(())
        }
        ClientMsg::Join { room, name } => state.rooms().join(id, &room, name, tx.clone()),
        ClientMsg::Play { position_ms } => state.rooms().play(id, position_ms, now),
        ClientMsg::Pause => state.rooms().pause(id, now),
        ClientMsg::Seek { position_ms } => state.rooms().seek(id, position_ms, now),
        ClientMsg::Assign { member, channel } => state.rooms().assign(id, member, channel),
        ClientMsg::Load { .. } => unreachable!("handled by the connection loop"),
    };
    if let Err(message) = result {
        reply_error(tx, message);
    }
}

fn reply_error(tx: &mpsc::UnboundedSender<Outgoing>, message: String) {
    let _ = tx.send(Outgoing::Text(ServerMsg::Error { message }));
}
