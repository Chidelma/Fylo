;(function installFylo(global, document) {
    'use strict'

    if ('Fylo' in global) throw new Error('Fylo is already defined on this page')

    const script = document.currentScript
    if (!script?.src) throw new Error('Fylo must be loaded from an external script URL')

    const moduleUrl = new URL('./fylo-web.mjs', script.src).href
    let modulePromise

    const load = () => (modulePromise ??= import(moduleUrl))

    async function open(options = {}) {
        const module = await load()
        const client = module.createBrowserClient(options)
        await client.ready()
        return client
    }

    global.Fylo = Object.freeze({ load, open })
})(globalThis, document)
