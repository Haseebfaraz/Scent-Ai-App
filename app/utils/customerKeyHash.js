import crypto from "crypto";

// Produces a one-way, salted identifier for "is this the same underlying customer as another
// order," WITHOUT ever storing or exposing the customer's actual name. Only used to count repeat
// purchases in aggregate (e.g. "3 of these 10 similar customers ordered again") — the hash itself
// must never appear in any tool output or customer-facing text, only COUNT()/DISTINCT() over it.
//
// The salt is required from the environment (CUSTOMER_KEY_HASH_SALT) and deliberately never has a
// hardcoded fallback: a name is a low-entropy string, so an unsalted (or fixed-salt-in-source)
// hash is trivially reversible via a dictionary/rainbow-table attack — that would defeat the
// entire point of not storing the name. Failing loudly here is safer than failing open.
export function hashCustomerKey(rawName) {
  const salt = process.env.CUSTOMER_KEY_HASH_SALT;
  if (!salt) {
    throw new Error(
      "CUSTOMER_KEY_HASH_SALT is not set — refusing to hash customer names with no salt " +
      "(an unsalted hash of a name is trivially reversible, which defeats the purpose)."
    );
  }
  if (!rawName || !rawName.trim()) return null;

  return crypto
    .createHmac("sha256", salt)
    .update(rawName.trim().toLowerCase())
    .digest("hex");
}
