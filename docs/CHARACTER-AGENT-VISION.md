# On-Site Character Agent — Vision & Scope Notes

Not a build plan. This is a capture of an idea to not lose. Explicitly
deferred — revisit with a fresh scoping pass if/when it's actually time to
build it.

## The framing, verbatim, because it's the whole point

This is a scoping doc, and the scoping is the hard part to get wrong. Straight
from whoever scoped it — read this twice before reading anything below it:

> "Agent in my view was just to verify site integrity not replace actual game
> mechanics or interact on chain. I mean conversational verification. Fun on
> site character you can talk to for support. nudge people to check and stay
> safe and explain things real time on landing page. like a helful friend
> when they land. Well designed UX and innovative chat box and character
> visibly talking with text bubble comic book style. text box to type in to
> run commands, ask questions and interact. nudges and on screen help and
> highlighting and tutorial features that are dynamic interactive and
> contextually aware agent and visuals. Not full chat. bring it to life not
> replace anything"

Three things that framing rules out immediately: **not** a chatbot, **not**
on-chain, **not** a replacement for any existing game mechanic. It's a
friendly presence layered on top of what already exists — it brings the site
to life, it doesn't reroute how the game works.

## What it actually is

- A visible on-site character, fitting the game's existing comic-book /
  pixel-art Hoodie aesthetic — not a generic floating chat-widget icon.
- Greets visitors on the landing page, speaks via comic-book-style text
  bubbles (matching the game's own visual language, not a chrome chat UI
  bolted on top of it).
- A text input so visitors can ask direct questions or type simple
  commands — but scoped and contextual, not an open-ended chatbot.

## What it's for

- **Trust, made conversational.** Walks people through the commit-footer /
  byte-diff verification (or whatever the attestation pipeline in
  [SITE-INTEGRITY-RESEARCH.md](SITE-INTEGRITY-RESEARCH.md) becomes) in
  plain talk, instead of making them go read the README. "Here's how you
  know this is really me" as a friendly explanation instead of a wall of
  `curl`/`diff` commands.
- **Onboarding and support.** Explains archetypes, controls, free-play vs
  wallet-play, whatever a new visitor is confused about — the stuff the
  README currently has to carry alone.
- **Dynamic, contextually-aware nudges.** Highlights relevant UI elements,
  shows up at the right moment — e.g. someone's been sitting on the setup
  screen too long, or a match just ended — instead of sitting static in a
  corner waiting to be clicked.

## What it must never do

- Never touches wallet actions, signatures, or anything value-related.
  Purely explanatory and navigational.
- This is load-bearing, not a nice-to-have: the game's whole trust story is
  "we never ask for a signature beyond reading your address." A character
  that starts prompting for input in a chat box, if it's not airtight about
  staying out of the wallet flow entirely, undermines exactly the trust
  it's supposed to be building. It reinforces the existing story or it
  doesn't ship.

## Cost reality

From research done alongside this: cheap models suitable for short, scoped
replies run cents to low-dollars per month per active user, if capped
server-side. Genuinely affordable for something this narrow. The real risk
is abuse / unbounded usage, not base cost — so whatever implementation
happens needs a hard rate limit regardless of how "free" the feature feels
to build.

## Precedent worth knowing

Treasure DAO's AI Agent Creator lets NFT holders convert their NFTs into
chat agents, priced via a small token top-up as inference credit. Not what
we're building — but proof this category of feature (NFT-gated AI, in a
crypto-native audience) is viable and has shipped before, if a paid/gated
version is ever worth considering later.

## Open question — deliberately not answered here

Does this stay free and unlimited-but-rate-limited, on the reasoning that
it's narrow/scoped and not a roleplay chat? Or does it eventually get a
real usage cap? Deferring that decision — it's not answered in this doc,
just flagged so it doesn't get silently decided by default when someone
finally builds this.
