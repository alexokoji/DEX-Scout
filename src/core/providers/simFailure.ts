/**
 * The pre-buy "can this be sold back?" check asks an aggregator to quote selling the token. A failure can mean two very
 * different things: the token genuinely has no sell route (a real red flag), or the lookup itself failed (a rate limit, a
 * timeout, a data hiccup). Treating both as "Sell simulation failed" blocked sound tokens whenever a provider was busy.
 *
 * A check is only conclusive when EVERY reason given is a real "no route"; a mix, or any transient failure, is inconclusive.
 */
const NO_ROUTE =
  /no (swap )?routes?( found)?|route not found|could not find any route|COULD_NOT_FIND_ANY_ROUTE|insufficient liquidity|no liquidity|not tradable|zero output|HTTP (400|404|422)\b/i;

export function sellCheckInconclusive(message: string): boolean {
  // "No swap route found on any aggregator (paraswap: HTTP 400 ...; kyberswap: HTTP 404 ...)" -> the individual reasons
  const inner = message.match(/\(([\s\S]*)\)\s*$/)?.[1] ?? message;
  const reasons = inner.split(/;\s+/).filter(Boolean);
  return !(reasons.length > 0 && reasons.every((r) => NO_ROUTE.test(r)));
}
