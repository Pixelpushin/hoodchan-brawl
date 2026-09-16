#!/bin/sh
# Runs as Vercel's buildCommand (see vercel.json) - not a real build, this
# site stays plain static files. Just stamps the commit Vercel is actually
# deploying into a JSON file the page can fetch at runtime, so a visitor can
# confirm what they're looking at matches a specific commit on GitHub
# instead of taking it on faith. VERCEL_GIT_COMMIT_SHA/REF are populated
# automatically by Vercel's git integration - empty when run outside Vercel
# (e.g. local dev), which the front end treats as "can't verify, not a
# Vercel deploy" rather than showing a broken/fake commit link.
#
# `version` is the SAME commit SHA, duplicated under the key
# api/_lib/room.js's readEngineVersion() (and api/auth/session.js's copy of
# it) actually look for - api/lobby/create.js stamps this onto every new
# room as `engineVersion`, api/lobby/join.js 426s a client whose own
# src/engine-version.js ENGINE_VERSION disagrees with it. Without this field
# both readers silently fall back to null and the whole
# ENGINE_VERSION_MISMATCH gate is inert in production.
printf '{"commit":"%s","branch":"%s","repo":"Pixelpushin/hoodchan-brawl","version":"%s"}\n' \
  "$VERCEL_GIT_COMMIT_SHA" "$VERCEL_GIT_COMMIT_REF" "$VERCEL_GIT_COMMIT_SHA" > version.json

# Same commit, exported as a JS module so server code (api/**) can pin/report
# an engine version without parsing version.json at runtime. Written
# alongside version.json, not instead of it - the two serve different
# consumers (browser fetch vs. server import).
printf 'export const ENGINE_VERSION = "%s";\n' \
  "$VERCEL_GIT_COMMIT_SHA" > src/engine-version.js
