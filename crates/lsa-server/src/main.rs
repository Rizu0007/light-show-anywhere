//! `lsa-server [--port 8787] [--static web/dist]`

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;

use tracing_subscriber::EnvFilter;

const DEFAULT_PORT: u16 = 8787;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let mut port = DEFAULT_PORT;
    let mut static_dir = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match (arg.as_str(), args.next()) {
            ("--port", Some(value)) => match value.parse() {
                Ok(value) => port = value,
                Err(_) => return usage(&format!("invalid port: {value}")),
            },
            ("--static", Some(value)) => static_dir = Some(PathBuf::from(value)),
            _ => return usage(&format!("unknown argument: {arg}")),
        }
    }

    // Listen on every interface so phones on the same Wi-Fi can connect.
    let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
    match lsa_server::serve(addr, static_dir).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            tracing::error!("{err}");
            ExitCode::FAILURE
        }
    }
}

fn usage(problem: &str) -> ExitCode {
    eprintln!("{problem}\nusage: lsa-server [--port {DEFAULT_PORT}] [--static web/dist]");
    ExitCode::FAILURE
}
