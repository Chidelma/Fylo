export default class {
    constructor(props = {}) {
        Object.assign(this, props)
    }

    hydrate(root) {
        this.root = root
    }
    /** @type {string} */
    openKey = 'rebuild'

    toggle(_event, key) {
        this.openKey = this.openKey === key ? '' : key
        for (const panel of this.root?.querySelectorAll('[data-faq]') ?? []) {
            const open = panel.dataset.faq === this.openKey
            panel.classList.toggle('open', open)
            panel.querySelector('button')?.setAttribute('aria-expanded', String(open))
        }
    }
}
