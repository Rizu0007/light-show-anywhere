//! `lsa-server [--port 8787] [--static web/dist] [--tls | --cert cert.pem --key key.pem]
//! [--wled wled.json]`
//!
//! `--tls` serves HTTPS with a self-signed certificate kept in `.lsa-tls/` (phones warn once);
//! `--cert`/`--key` use your own certificate. `--wled` drives the LED strips listed in the file.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;

use lsa_server::tls::Tls;
use lsa_server::wled;
use tracing_subscriber::EnvFilter;

const DEFAULT_PORT: u16 = 8787;
/// Where `--tls` keeps its self-signed certificate (relative to the working directory).
const TLS_DIR: &str = ".lsa-tls";

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let mut port = DEFAULT_PORT;
    let mut static_dir = None;
    let mut self_signed = false;
    let mut cert = None;
    let mut key = None;
    let mut wled_config = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--tls" {
            self_signed = true;
            continue;
        }
        match (arg.as_str(), args.next()) {
            ("--port", Some(value)) => match value.parse() {
                Ok(value) => port = value,
                Err(_) => return usage(&format!("invalid port: {value}")),
            },
            ("--static", Some(value)) => static_dir = Some(PathBuf::from(value)),
            ("--cert", Some(value)) => cert = Some(PathBuf::from(value)),
            ("--key", Some(value)) => key = Some(PathBuf::from(value)),
            ("--wled", Some(value)) => match wled::Config::load(value.as_ref()) {
                Ok(config) => wled_config = Some(config),
                Err(err) => return usage(&format!("{value}: {err}")),
            },
            _ => return usage(&format!("unknown argument: {arg}")),
        }
    }

    let tls = match (self_signed, cert, key) {
        (false, None, None) => None,
        (true, None, None) => Some(Tls::SelfSigned(PathBuf::from(TLS_DIR))),
        (false, Some(cert), Some(key)) => Some(Tls::Files { cert, key }),
        (true, _, _) => return usage("use either --tls or --cert/--key"),
        _ => return usage("--cert and --key go together"),
    };

    // Listen on every interface so phones on the same Wi-Fi can connect.
    let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
    match lsa_server::serve(addr, static_dir, tls, wled_config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            tracing::error!("{err}");
            ExitCode::FAILURE
        }
    }
}

fn usage(problem: &str) -> ExitCode {
    eprintln!(
        "{problem}\nusage: lsa-server [--port {DEFAULT_PORT}] [--static web/dist] \
         [--tls | --cert cert.pem --key key.pem] [--wled wled.json]"
    );
    ExitCode::FAILURE
}
