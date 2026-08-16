#!/bin/sh
# Runs as Vercel's buildCommand (see vercel.json) - not a real build, this
# site stays plain static files. Just stamps the commit Vercel is actually
# deploying into a JSON file the page can fetch at runtime, so a visitor can
# confirm what they're looking at matches a specific commit on GitHub
# instead of taking it on faith. VERCEL_GIT_COMMIT_SHA/REF are populated
# automatically by Vercel's git integration - empty when run outside Vercel
# (e.g. local dev), which the front end treats as "can't verify, not a
# Vercel deploy" rather than showing a broken/fake commit link.
printf '{"commit":"%s","branch":"%s","repo":"Pixelpushin/hoodies-fight"}\n' \
  "$VERCEL_GIT_COMMIT_SHA" "$VERCEL_GIT_COMMIT_REF" > version.json
