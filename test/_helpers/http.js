// Minimal fake req/res for calling a Vercel-style (req, res) handler
// directly in a test, without spinning up a server. Mirrors the inline shim
// scripts/test-lobby-join.mjs already uses, factored out for reuse.
"use strict";

function makeReq({ method = "POST", body, headers = {}, query = {} } = {}) {
  return { method, body, headers, query };
}

// Resolves once the handler calls res.json(...) or res.end(...), capturing
// whatever status/headers were set along the way.
function call(handler, req) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      setHeader(key, value) {
        headers[key] = value;
      },
      status(code) {
        this._status = code;
        return this;
      },
      json(body) {
        resolve({ status: this._status, body, headers });
      },
      end(body) {
        resolve({ status: this._status, body, headers });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

module.exports = { makeReq, call };
