# Security follow-up: `/chat` endpoint identity verification

**Status:** documented, not fixed — explicitly out of scope for the "feel human" conversation
refactor. Fixed as part of that refactor: CORS on `/chat` no longer allows `*`; it now only allows
the real shop's storefront origin (see `resolveAllowedChatOrigin` in `app/routes/chat.jsx`).

## The remaining gap

`app/routes/chat.jsx`'s `action()` trusts `customer_email` and `customer_name` straight from the
POST body, with no server-side verification against a real Shopify session or token. The comment
in the code justifies this by pointing to the storefront theme extension gating the chat widget
behind `{% if customer %}` — but that's a client-side-only gate. Anyone who can POST directly to
`/chat` (bypassing the widget entirely) can supply any name/email they like, and the server has no
way to tell the difference.

Separately, nothing ties a `conversation_id` to a verified owner. It's a `crypto.randomUUID()` (not
guessable), but if one were ever exposed — through logs, browser history, a shared screenshot, a
support ticket — whoever has it can continue that real conversation and read the associated
customer profile.

## The real fix

Migrate `/chat` through the Shopify App Proxy, the same mechanism the sibling route
`app/routes/apps.scent-library.fragrance-preview.jsx` already uses correctly
(`authenticate.public.appProxy(request)`). The App Proxy cryptographically verifies the request came
from Shopify and can resolve a real, verified customer identity server-side — removing the need to
trust anything the client claims about who's talking.

This is a genuine architectural change (routing, request signing, how the storefront widget calls
the endpoint) and was deliberately not attempted in this pass, per the refactor spec's own
instruction to document rather than make a risky partial change to authentication.
