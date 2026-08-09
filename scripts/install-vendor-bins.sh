#!/bin/sh
# Install repository-pinned TTID and CHEX binaries without executing remote
# installer code. Versions and SHA-256 digests are anchored in this script so
# a mutable release, installer, or checksum file cannot silently change CI.
set -eu

TTID_VERSION='v26.32.03'
CHEX_VERSION='v26.32.02'
DESTINATION=${FYLO_VENDOR_BIN_DIR:-"$HOME/.local/bin"}

case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)
        TTID_ASSET='ttid-linux-x64'
        TTID_SHA256='2ec6d27844720cdbaf7f9b4e06ab20f06cb69aa272930a22eca0edf57ef4dcf4'
        CHEX_ASSET='chex-linux-x64'
        CHEX_SHA256='ed0b71cb5d75a35e13e29b4a160e68d6f3e6221e3da6d80ca5a0361f92e5579b'
        ;;
    Linux-aarch64|Linux-arm64)
        TTID_ASSET='ttid-linux-arm64'
        TTID_SHA256='3c90dae83d6b94e4aecfa464d47196f8bc0719efa05b62e5d2fa35c419cbf676'
        CHEX_ASSET='chex-linux-arm64'
        CHEX_SHA256='1ec31aa7201d6ab3af8114725406050dd48fc6ca052c74a7be378510a1ec96af'
        ;;
    Darwin-arm64)
        TTID_ASSET='ttid-macos-arm64'
        TTID_SHA256='2aa3c44d180111ced6fd009f63d336450df7c1559c2552ab3044c51be2f65609'
        CHEX_ASSET='chex-macos-arm64'
        CHEX_SHA256='a3869779fdc12210fdf9c8cc54d4ea136912516a76de47621d304dbbeaac47ce'
        ;;
    Darwin-x86_64)
        TTID_ASSET='ttid-macos-x64'
        TTID_SHA256='24f7d87480b40333429758113108d977604d99f64f8394b919505702ab9ad1bd'
        CHEX_ASSET='chex-macos-x64'
        CHEX_SHA256='1b410bf166ffddf2921f661a18c3e90ba2ab74818f7a125fff4d20f0c3566806'
        ;;
    MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64)
        TTID_ASSET='ttid-windows-x64.exe'
        TTID_SHA256='41c06d2305e40ceb34baefc214610a869defc772501047e39c23427e0ff8565f'
        CHEX_ASSET='chex-windows-x64.exe'
        CHEX_SHA256='3aa465447849d1f0d43318cd7c0e3c69a7db8cc06055a0c6ba0b4d53c24334bc'
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
