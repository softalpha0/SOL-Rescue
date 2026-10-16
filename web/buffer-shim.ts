// Browsers have no Node Buffer; the shared rescue logic and web3.js expect one.
export { Buffer } from "buffer";