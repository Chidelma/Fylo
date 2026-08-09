const RELEASES = 'https://github.com/d31ma/Fylo/releases/latest/download'

export default class extends Tac {
    assets = [
        { label: 'macOS (Apple Silicon)', file: 'fylo-macos-arm64' },
        { label: 'macOS (Intel)', file: 'fylo-macos-x64' },
        { label: 'Linux (x64)', file: 'fylo-linux-x64' },
        { label: 'Linux (ARM64)', file: 'fylo-linux-arm64' },
        { label: 'Windows (x64)', file: 'fylo-windows-x64.exe' },
        { label: 'Web (self-hosted Explorer)', file: 'fylo-explorer-26.32.07.zip' }
    ]

    assetUrl(file) {
        return `${RELEASES}/${file}`
    }

    unixInstall() {
        return 'curl -fsSL https://fylo.del.ma/install.sh | sh'
    }

    windowsInstall() {
        return 'irm https://fylo.del.ma/install.ps1 | iex'
    }
}
