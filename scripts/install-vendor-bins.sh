#!/bin/sh
# Install repository-pinned TTID and CHEX binaries without executing remote
# installer code. Versions and SHA-256 digests are anchored in this script so
# a mutable release, installer, or checksum file cannot silently change CI.
set -eu

TTID_VERSION='v26.28.02'
CHEX_VERSION='v26.28.02'
DESTINATION=${FYLO_VENDOR_BIN_DIR:-"$HOME/.local/bin"}

case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)
        TTID_ASSET='ttid-linux-x64'
        TTID_SHA256='93a1bf501eb8e8ad41c19904ae1424be13b7aa6a2a5d8de12767f681a70a62f4'
        CHEX_ASSET='chex-linux-x64'
        CHEX_SHA256='558587913b7f69407946ceb37fb99dc3009bae86ab349fb3d5e79c42556d821d'
        ;;
    Linux-aarch64|Linux-arm64)
        TTID_ASSET='ttid-linux-arm64'
        TTID_SHA256='fdcd2481d0d3e56b2bc31fac0a9af85e53cf7a44361253e211119abdee99e969'
        CHEX_ASSET='chex-linux-arm64'
        CHEX_SHA256='a673bce8b6484be589fa66191e70ca9bd9bbdcbc2857df19dc6ba4e129c7346e'
        ;;
    Darwin-arm64)
        TTID_ASSET='ttid-macos-arm64'
        TTID_SHA256='a0c41c6a57a3ceefb30d99835afd677f1807917dcb73dd0abe1499e3802c8126'
        CHEX_ASSET='chex-macos-arm64'
        CHEX_SHA256='bb14b34090306a221a360d976e4ed0218c10235cf2767433e136e7c2e5fc77ba'
        ;;
    Darwin-x86_64)
        TTID_ASSET='ttid-macos-x64'
        TTID_SHA256='8a5558c3fb3a5c654a8c366d04c59a3a10f7d68f7f045b345638d149daec1c1d'
        CHEX_ASSET='chex-macos-x64'
        CHEX_SHA256='a1668b30e9b11cc495f04a986b3fb572cdddb6d325d9723184d2d75c36de84e9'
        ;;
    MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64)
        TTID_ASSET='ttid-windows-x64.exe'
        TTID_SHA256='b4beab399741b46a82d037cfef2b298418e7596245684aed91154aee8d6771aa'
        CHEX_ASSET='chex-windows-x64.exe'
        CHEX_SHA256='d00d48eeaf5f24fa39ec8dfc2f6963ab8ab1a38e20523e239bea63498815bd18'
        EXECUTABLE_SUFFIX='.exe'
        ;;
    *)
        echo "Unsupported vendor-binary platform: $(uname -s)/$(uname -m)" >&2
        exit 1
        ;;
esac

# Windows needs the extension to be executable; every other platform must not
# have one, so callers can always spawn a bare `ttid`/`chex`.
EXECUTABLE_SUFFIX=${EXECUTABLE_SUFFIX:-}

verify_sha256() {
    file=$1
    expected=$2
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$file" | awk '{print $1}')
    else
        actual=$(shasum -a 256 "$file" | awk '{print $1}')
    fi
    if [ "$actual" != "$expected" ]; then
        echo "SHA-256 mismatch for $(basename "$file")" >&2
        exit 1
    fi
}

install_binary() {
    repository=$1
    version=$2
    asset=$3
    expected=$4
    executable=$5
    temporary=$(mktemp "${TMPDIR:-/tmp}/fylo-vendor.XXXXXX")
    trap 'rm -f "$temporary"' EXIT HUP INT TERM
    curl --fail --silent --show-error --location --retry 3 \
        "https://github.com/$repository/releases/download/$version/$asset" \
        --output "$temporary"
    verify_sha256 "$temporary" "$expected"
    install -m 0755 "$temporary" "$DESTINATION/$executable"
    rm -f "$temporary"
    trap - EXIT HUP INT TERM
    echo "Installed verified $repository@$version/$asset."
}

mkdir -p "$DESTINATION"
install_binary 'd31ma/TTID' "$TTID_VERSION" "$TTID_ASSET" "$TTID_SHA256" "ttid$EXECUTABLE_SUFFIX"
install_binary 'd31ma/CHEX' "$CHEX_VERSION" "$CHEX_ASSET" "$CHEX_SHA256" "chex$EXECUTABLE_SUFFIX"

"$DESTINATION/ttid$EXECUTABLE_SUFFIX" --help >/dev/null
"$DESTINATION/chex$EXECUTABLE_SUFFIX" --help >/dev/null
echo "Verified TTID and CHEX in $DESTINATION."
