//! HTTPS, which phones need for the wake lock and flashlight. By default a self-signed
//! certificate for this computer's network addresses, kept and reused so phones warn only once;
//! renewed for a new address (old ones stay in) or near expiry.

use std::collections::BTreeSet;
use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use rcgen::{CertificateParams, ExtendedKeyUsagePurpose, KeyPair};
use time::{Duration, OffsetDateTime};

/// Where the HTTPS certificate comes from.
#[derive(Debug, Clone)]
pub enum Tls {
    /// A self-signed certificate kept in this folder (created when needed).
    SelfSigned(PathBuf),
    /// A certificate and private key in PEM files, e.g. from a real domain.
    Files {
        /// Certificate chain.
        cert: PathBuf,
        /// Private key.
        key: PathBuf,
    },
}

/// A certificate and its private key, PEM encoded.
#[derive(Debug, Clone)]
pub struct Pem {
    /// Certificate chain.
    pub cert: Vec<u8>,
    /// Private key.
    pub key: Vec<u8>,
}

/// Days a generated certificate is valid. Apple devices reject server certificates valid for
/// more than 825 days.
const VALID_DAYS: i64 = 365;
/// A certificate this close to expiry is replaced.
const RENEW_DAYS: i64 = 30;

const CERT_FILE: &str = "cert.pem";
const KEY_FILE: &str = "key.pem";
/// First line: expiry (Unix seconds). Then one covered name per line.
const INFO_FILE: &str = "names.txt";

impl Tls {
    /// Reads the certificate, creating or renewing a self-signed one if needed.
    pub fn load(&self) -> io::Result<Pem> {
        match self {
            Self::SelfSigned(dir) => self_signed(dir, &local_names()),
            Self::Files { cert, key } => Ok(Pem {
                cert: std::fs::read(cert)?,
                key: std::fs::read(key)?,
            }),
        }
    }
}

/// This computer's IPv4 network addresses that phones can reach (no loopback or link-local).
#[must_use]
pub fn lan_addresses() -> Vec<IpAddr> {
    let mut addresses: Vec<IpAddr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|iface| !iface.is_loopback() && !iface.is_link_local())
        .map(|iface| iface.ip())
        .filter(IpAddr::is_ipv4)
        .collect();
    addresses.sort();
    addresses.dedup();
    addresses
}

/// Names the certificate must cover: localhost and every network address.
fn local_names() -> BTreeSet<String> {
    ["localhost", "127.0.0.1", "::1"]
        .into_iter()
        .map(String::from)
        .chain(lan_addresses().iter().map(IpAddr::to_string))
        .collect()
}

/// Loads the self-signed certificate in `dir`, or makes a new one when it does not cover
/// `names` or expires within 30 days.
pub fn self_signed(dir: &Path, names: &BTreeSet<String>) -> io::Result<Pem> {
    let now = OffsetDateTime::now_utc();
    if let Some((expires, covered)) = read_info(dir)
        && covered.is_superset(names)
        && expires - now > Duration::days(RENEW_DAYS)
        && let (Ok(cert), Ok(key)) = (
            std::fs::read(dir.join(CERT_FILE)),
            std::fs::read(dir.join(KEY_FILE)),
        )
    {
        return Ok(Pem { cert, key });
    }

    let mut all = read_info(dir)
        .map(|(_, covered)| covered)
        .unwrap_or_default();
    all.extend(names.iter().cloned());
    let expires = now + Duration::days(VALID_DAYS);
    let pem = generate(&all, now, expires).map_err(io::Error::other)?;

    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(CERT_FILE), &pem.cert)?;
    write_private(&dir.join(KEY_FILE), &pem.key)?;
    let mut info = format!("{}\n", expires.unix_timestamp());
    for name in &all {
        info.push_str(name);
        info.push('\n');
    }
    std::fs::write(dir.join(INFO_FILE), info)?;
    tracing::info!("created a certificate for {all:?} in {}", dir.display());
    Ok(pem)
}

fn generate(
    names: &BTreeSet<String>,
    now: OffsetDateTime,
    expires: OffsetDateTime,
) -> Result<Pem, rcgen::Error> {
    let mut params = CertificateParams::new(names.iter().cloned().collect::<Vec<_>>())?;
    params.distinguished_name.push(
        rcgen::DnType::CommonName,
        "Light Show Anywhere party server",
    );
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    // A little slack for phones whose clocks run behind.
    params.not_before = now - Duration::days(1);
    params.not_after = expires;
    let key = KeyPair::generate()?;
    let cert = params.self_signed(&key)?;
    Ok(Pem {
        cert: cert.pem().into_bytes(),
        key: key.serialize_pem().into_bytes(),
    })
}

fn read_info(dir: &Path) -> Option<(OffsetDateTime, BTreeSet<String>)> {
    let info = std::fs::read_to_string(dir.join(INFO_FILE)).ok()?;
    let mut lines = info.lines();
    let expires = OffsetDateTime::from_unix_timestamp(lines.next()?.parse().ok()?).ok()?;
    Some((expires, lines.map(String::from).collect()))
}

/// Writes a file only the current user can read (where the platform supports it).
fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(contents)
}
