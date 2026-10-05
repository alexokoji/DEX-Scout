/** An error with an HTTP status that routes turn into a clear response. `hint` is a machine-readable suggestion for the UI (e.g. { slippageBps } or { verify: "evm" }). */
export class TradeError extends Error {
  constructor(message: string, public status = 400, public violations: string[] = [], public hint?: Record<string, number | string>) {
    super(message);
  }
}
