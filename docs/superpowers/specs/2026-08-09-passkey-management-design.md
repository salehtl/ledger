# Managing passkeys — design

**Date:** 2026-08-09
**Status:** approved by the operator, ready for a plan
**Depends on:** nothing. Interacts with the PRF unlock work (`user_key_wraps`).

---

## 1. Why this exists

A user can **add** a passkey today. They cannot **see** what they have, and they
cannot **remove** one. That is a gap with real consequences: a lost phone leaves a
credential that can sign in to the account forever, and the user has no way to end
it.

## 2. What exists today, verified

| Capability | State |
|---|---|
| Register the first passkey | `POST /api/v1/auth/passkey/register/begin` + `/finish` |
| Sign in | `POST /api/v1/auth/passkey/login/begin` + `/finish` |
| Add another passkey | `POST /api/v1/auth/passkey/add/begin` + `/finish`, and a Settings control |
| **List passkeys** | **does not exist** |
| **Remove a passkey** | **does not exist** |
| List / delete a PRF key wrap | `GET` and `DELETE /api/v1/keys/wraps` |

So the server work is two new endpoints, and the client work is one screen.

The passkey display name was recently corrected to "Ledger by Sirdab". **WebAuthn
has no rename** — the name is copied into the authenticator when the credential is
created. Existing passkeys keep the old name, and this design cannot change that.
The screen should not imply otherwise.

## 3. The design

### Server: two endpoints

**`GET /api/v1/auth/passkeys`** returns the caller's credentials. For each: an
opaque credential id, when it was created, when it was last used, whether it
carries a PRF key wrap, and — if the authenticator supplied it — the AAGUID-derived
authenticator name.

It returns **no public key material**. There is no reason for the client to hold
it, and a list endpoint that returns key bytes is a needless liability.

**`DELETE /api/v1/auth/passkeys/{credential_id}`** removes one credential.

### The refusal that matters most

> **The server MUST refuse to delete the caller's last remaining passkey.**

Not a client-side guard — a server-side one, with its own error code. A passkey is
the only way in. Deleting the last one is an unrecoverable lockout, and the
recovery phrase unlocks *data*, it does not restore *access*.

The client must not be the thing that knows this rule. A client-side check is a
guard a future screen forgets.

### Deleting a credential takes its key wrap with it

`user_key_wraps` references `webauthn_credentials(credential_id)` with
`ON DELETE CASCADE`. So removing a passkey removes its PRF wrap automatically. This
must be **asserted in a test**, not assumed from the schema: the cascade is the
thing that stops a deleted authenticator's wrap lingering.

Losing a PRF wrap loses nothing — the recovery phrase still opens the account. That
is why `DELETE` is correct here, where it is deliberately absent for published
keys.

### Sessions belonging to a removed credential

Removing a passkey must **end the sessions that credential created**. Otherwise
"remove my lost phone" leaves the lost phone signed in, which is the exact thing
the user was trying to stop. If sessions do not record which credential
authenticated them, the plan must add that; it is the point of the feature.

**This is the one open question in this design** and the plan must resolve it
before building the screen.

### Client: one screen in the Device group

A list, in Settings under **Device**, where "Passkeys" already lives. Each row
shows the authenticator name if known, when it was added, when it was last used,
and a marker for **this device's** credential.

Rules:

- **The current credential is labelled**, so a user does not remove the one they
  are standing on.
- Removal is a destructive confirm, in a Dialog, naming what will happen: that
  device can no longer sign in.
- When only one passkey remains, the remove control is **disabled with a reason
  shown** — not hidden. A hidden control teaches nothing; a disabled one with a
  sentence explains the rule.
- The screen states plainly that a passkey created earlier keeps its old name.
  Behind an `InfoTip`, per the tooltip design: this is a mechanism, not a decision.

## 4. Testing

- **Prove every test bites.** Mutate, watch it fail, revert.
- Deleting the last passkey is refused **by the server**, with its own code. Invert
  the guard and watch the test fail.
- Deleting a passkey cascades its `user_key_wraps` row.
- Deleting a passkey ends that credential's sessions, and **does not** end others.
- The list returns no key material.
- A caller cannot list or delete another account's credentials — the session
  resolves the account, and there is no user field on the wire.
- The screen disables removal at one credential and gives the reason.

## 5. Out of scope

Renaming a passkey — WebAuthn does not support it. Cross-device credential sync
management — that belongs to the platform, not to this app.
