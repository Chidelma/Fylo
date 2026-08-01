/**
 * Public JavaScript entry for the native Rust engine.
 *
 * The JavaScript package is deliberately a thin machine-protocol client. All
 * native storage, query, permission, recovery, and versioning behavior lives
 * in the `fylo` executable; importing this module never opens a root directly.
 */
export { Fylo } from '../clients/node/fylo.mjs'
export { Fylo as default } from '../clients/node/fylo.mjs'
