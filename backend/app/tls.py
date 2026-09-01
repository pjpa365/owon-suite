"""Self-signed TLS certificate for LAN mode (Mobile Requirements.txt follow-up:
the Wake Lock API, and any other secure-context-only browser feature, needs
HTTPS -- plain HTTP can never satisfy that, regardless of browser/OS).

Pure Python (the `cryptography` package, an ordinary pip dependency) rather
than an external tool like mkcert -- deliberately, so this app can eventually
ship as a self-contained installable package without bundling/depending on a
separate binary. The trade-off: without a locally-trusted CA (what mkcert
provides), a phone's browser still shows a one-time "connection isn't
private" warning to click through -- clicking through is still enough to
make the browser treat the page as a secure context, which is what actually
unlocks the Wake Lock API; it just doesn't make the warning disappear
entirely the way installing a trusted CA on the phone would.

The certificate covers whatever LAN IP is detected at the time it's
generated (lan_ip.detect_lan_ip()) -- ensure_cert() regenerates it only when
that IP has actually changed since the last run (a marker file records
which IP the current certificate was issued for), not on every LAN-mode
start.
"""

from __future__ import annotations

import datetime
import ipaddress
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

CERT_DIR = Path(__file__).resolve().parent.parent / "certs"
CERT_FILE = CERT_DIR / "lan-cert.pem"
KEY_FILE = CERT_DIR / "lan-key.pem"
IP_MARKER_FILE = CERT_DIR / "lan-ip.txt"

_VALIDITY_DAYS = 825  # under the ~398-day CA/Browser Forum cap doesn't apply
# to self-signed/non-publicly-trusted certs, but some browsers still balk at
# absurdly long lifetimes -- comfortably long without being flagged.


def _generate(ip: str) -> None:
    CERT_DIR.mkdir(parents=True, exist_ok=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, ip)])
    now = datetime.datetime.now(datetime.timezone.utc)

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=_VALIDITY_DAYS))
        .add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.IPAddress(ipaddress.ip_address(ip)),
                    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                    x509.DNSName("localhost"),
                ]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    CERT_FILE.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    KEY_FILE.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    IP_MARKER_FILE.write_text(ip, encoding="utf-8")


def ensure_cert(ip: str) -> tuple[Path, Path]:
    """Returns (cert_path, key_path), generating a fresh certificate only if
    none exists yet or the LAN IP has changed since the last one was made."""
    existing_ip = IP_MARKER_FILE.read_text(encoding="utf-8").strip() if IP_MARKER_FILE.exists() else None
    if existing_ip != ip or not CERT_FILE.exists() or not KEY_FILE.exists():
        _generate(ip)
    return CERT_FILE, KEY_FILE


def current_cert_exists() -> bool:
    """Whether a LAN-mode certificate exists at all right now -- used to pick
    http vs. https when building the mobile URL/QR code (settings.py), since
    that can be asked before or without LAN mode ever having run."""
    return CERT_FILE.exists() and KEY_FILE.exists()
