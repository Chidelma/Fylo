import { CLIENT_COUNT } from '/shared/scripts/shims.js'

export default class {
    hydrate(root) {
        this.root = root
    }
    installCmd = 'curl -fsSL https://fylo.del.ma/install.sh | sh'
    installCopied = false

    ticks = [
        'Filesystem-first',
        'Zero native addons',
        'One self-contained binary',
        `${CLIENT_COUNT} language clients included`
    ]
    async copyInstall() {
        const hint = this.root?.querySelector('.hero-copy-hint')
        try {
            await navigator.clipboard.writeText(this.installCmd)
            this.installCopied = true
            if (hint) hint.textContent = 'copied ✓'
            setTimeout(() => {
                this.installCopied = false
                if (hint) hint.textContent = 'copy'
            }, 2200)
        } catch (_) {
            /* clipboard unavailable — hint text stays */
        }
        return this.installCmd
    }
}
