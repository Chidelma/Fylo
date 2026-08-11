import { CLIENT_COUNT } from '/shared/scripts/shims.js'

export default class {
    hydrate() {}
    // Exposed for template interpolation ({clientCount} in tac.html).
    clientCount = CLIENT_COUNT
}
