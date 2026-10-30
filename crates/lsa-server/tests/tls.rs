//! Self-signed certificate creation and reuse.

use std::collections::BTreeSet;
use std::path::PathBuf;

use lsa_server::tls::self_signed;

fn names(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|&name| name.to_owned()).collect()
}

fn temp_dir(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lsa-tls-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn certificate_is_created_then_reused() {
    let dir = temp_dir("reuse");
    let wanted = names(&["localhost", "192.168.1.20"]);
    let first = self_signed(&dir, &wanted).unwrap();
    assert!(String::from_utf8_lossy(&first.cert).starts_with("-----BEGIN CERTIFICATE-----"));
    assert!(String::from_utf8_lossy(&first.key).contains("PRIVATE KEY"));

    // Phones that accepted the certificate are not asked again.
    let again = self_signed(&dir, &wanted).unwrap();
    assert_eq!(again.cert, first.cert);
    // A subset of the covered names is still covered.
    let subset = self_signed(&dir, &names(&["localhost"])).unwrap();
    assert_eq!(subset.cert, first.cert);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("key.pem"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn new_network_address_renews_and_keeps_old_ones() {
    let dir = temp_dir("renew");
    let home = self_signed(&dir, &names(&["localhost", "192.168.1.20"])).unwrap();
    let venue = self_signed(&dir, &names(&["localhost", "10.0.0.5"])).unwrap();
    assert_ne!(venue.cert, home.cert);

    let covered = std::fs::read_to_string(dir.join("names.txt")).unwrap();
    assert!(covered.contains("192.168.1.20") && covered.contains("10.0.0.5"));
    // Back home: the renewed certificate covers both networks.
    let back = self_signed(&dir, &names(&["localhost", "192.168.1.20"])).unwrap();
    assert_eq!(back.cert, venue.cert);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn certificate_near_expiry_is_renewed() {
    let dir = temp_dir("expiry");
    let wanted = names(&["localhost"]);
    let first = self_signed(&dir, &wanted).unwrap();

    let info = std::fs::read_to_string(dir.join("names.txt")).unwrap();
    let (_, covered) = info.split_once('\n').unwrap();
    let soon = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 24 * 3600;
    std::fs::write(dir.join("names.txt"), format!("{soon}\n{covered}")).unwrap();

    assert_ne!(self_signed(&dir, &wanted).unwrap().cert, first.cert);
    std::fs::remove_dir_all(&dir).unwrap();
}
