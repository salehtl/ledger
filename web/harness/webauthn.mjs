/**
 * A software passkey, for the engine Playwright cannot give one to.
 *
 * # Why this had to exist
 *
 * `recovery.mjs` gets its authenticator from CDP
 * (`WebAuthn.addVirtualAuthenticator`), which is Chromium-only. So every
 * ceremony test in this repo ran in Chromium — and the bug that shipped to the
 * operator was **WebKit-only**: an X25519 `CryptoKey` written to IndexedDB there
 * reads back as `null` forever. The engine that could not be tested was the
 * engine that was broken.
 *
 * `harness/vault.mjs` covers the storage property in WebKit with no passkey at
 * all, and that is the assertion that would have caught it. This file is the
 * other half: it makes the WHOLE path — sign up, phrase, onboarding, reload —
 * runnable in WebKit, by replacing `navigator.credentials` with a real
 * authenticator written in WebCrypto.
 *
 * # It is a real authenticator, not a stub
 *
 * It mints an ES256 key pair, builds `attestationObject` as CBOR with `fmt:
 * "none"`, and signs assertions over `authData || SHA-256(clientDataJSON)` in
 * DER. `go-webauthn` verifies those signatures on the server with no idea this
 * is not hardware — which is the point: a stub that fabricated a session would
 * prove nothing about the server, and would not have caught a client that
 * encoded a field wrongly.
 *
 * It is resident/discoverable (it returns `userHandle`), because this product's
 * sign-in is username-less and resolves the account from that handle.
 *
 * The key pair is kept in `localStorage` under one key, so it survives the
 * reload the operator's path depends on. That is not how a platform
 * authenticator works — a real one keeps it out of the page entirely — and it is
 * the one respect in which this is a model rather than the thing.
 */

export const AUTHENTICATOR_STORAGE_KEY = "ledger-harness-authenticator";

/**
 * The init script, as a string.
 *
 * A string rather than a function reference because it is installed with
 * `context.addInitScript`, which serialises it into a fresh realm before any
 * page script runs — including on reload, which is exactly the moment under
 * test.
 */
export function authenticatorScript(rpId) {
  return `(() => {
  const RP_ID = ${JSON.stringify(rpId)};
  const STORE = ${JSON.stringify(AUTHENTICATOR_STORAGE_KEY)};

  const u8 = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));
  const cat = (...parts) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };
  const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const unb64url = (s) => {
    const t = s.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
  };
  const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

  // --- the smallest CBOR encoder that produces a valid attestation object ---
  const head = (major, n) => {
    if (n < 24) return new Uint8Array([(major << 5) | n]);
    if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
    if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
    return new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  };
  const cbor = (v) => {
    if (typeof v === "number") return v < 0 ? head(1, -v - 1) : head(0, v);
    if (typeof v === "string") { const b = new TextEncoder().encode(v); return cat(head(3, b.length), b); }
    if (v instanceof Uint8Array) return cat(head(2, v.length), v);
    if (v instanceof Map) return cat(head(5, v.size), ...[...v].map(([k, x]) => cat(cbor(k), cbor(x))));
    throw new Error("cbor: unsupported value");
  };

  // WebCrypto returns ECDSA signatures as r||s; WebAuthn wants DER.
  const der = (raw) => {
    const int = (b) => {
      let i = 0;
      while (i < b.length - 1 && b[i] === 0) i++;
      const body = b[i] & 0x80 ? cat(new Uint8Array([0]), b.slice(i)) : b.slice(i);
      return cat(new Uint8Array([0x02, body.length]), body);
    };
    const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
    return cat(new Uint8Array([0x30, body.length]), body);
  };

  const load = () => {
    const raw = localStorage.getItem(STORE);
    return raw === null ? null : JSON.parse(raw);
  };
  const save = (rec) => localStorage.setItem(STORE, JSON.stringify(rec));

  const clientData = (type, challenge) =>
    new TextEncoder().encode(JSON.stringify({
      type,
      challenge: b64url(u8(challenge)),
      origin: location.origin,
      crossOrigin: false,
    }));

  const credentials = {
    async create(options) {
      const pk = options.publicKey;
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
      const spki = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const credId = crypto.getRandomValues(new Uint8Array(16));
      const userHandle = u8(pk.user.id);
      save({ jwk, credId: b64url(credId), userHandle: b64url(userHandle) });

      // COSE_Key for ES256: kty EC2, alg -7, crv P-256, x, y.
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, spki.slice(1, 33)], [-3, spki.slice(33, 65)]]));
      const authData = cat(
        await sha256(new TextEncoder().encode(RP_ID)),
        new Uint8Array([0x45]), // UP | UV | AT
        new Uint8Array([0, 0, 0, 0]),
        new Uint8Array(16), // aaguid
        new Uint8Array([credId.length >> 8, credId.length & 0xff]),
        credId,
        cose,
      );
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      const cdj = clientData("webauthn.create", pk.challenge);

      return {
        id: b64url(credId),
        rawId: credId.buffer,
        type: "public-key",
        authenticatorAttachment: "platform",
        getClientExtensionResults: () => ({ credProps: { rk: true } }),
        response: {
          clientDataJSON: cdj.buffer,
          attestationObject: attestationObject.buffer,
          getTransports: () => ["internal"],
        },
      };
    },

    async get(options) {
      const rec = load();
      if (rec === null) throw new DOMException("no credential on this authenticator", "NotAllowedError");
      const key = await crypto.subtle.importKey("jwk", rec.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      const credId = unb64url(rec.credId);
      const cdj = clientData("webauthn.get", options.publicKey.challenge);
      const authData = cat(
        await sha256(new TextEncoder().encode(RP_ID)),
        new Uint8Array([0x05]), // UP | UV
        new Uint8Array([0, 0, 0, 1]),
      );
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, cat(authData, await sha256(cdj))),
      );
      return {
        id: rec.credId,
        rawId: credId.buffer,
        type: "public-key",
        authenticatorAttachment: "platform",
        getClientExtensionResults: () => ({}),
        response: {
          clientDataJSON: cdj.buffer,
          authenticatorData: authData.buffer,
          signature: der(raw).buffer,
          userHandle: unb64url(rec.userHandle).buffer,
        },
      };
    },
  };

  Object.defineProperty(navigator, "credentials", { value: credentials, configurable: true });
  window.PublicKeyCredential = window.PublicKeyCredential ?? function PublicKeyCredential() {};
  window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  window.PublicKeyCredential.isConditionalMediationAvailable = async () => false;
})();`;
}
