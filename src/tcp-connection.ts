/**
 * Re-exports the Bun-based TCP stream implementation for backward compatibility.
 *
 * For explicit runtime targeting, import directly from:
 * - `./tcp-connection-bun.js` (Bun native sockets)
 * - `./tcp-connection-nodejs.js` (Node.js `node:net` / `node:tls`)
 * - `./tcp-connection-common.js` (Shared contracts and error definitions)
 */
export * from "./tcp-connection-bun.js";
