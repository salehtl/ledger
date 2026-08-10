// Package pushv2 delivers content-free push notifications.
//
// One transport remains: Web Push (VAPID) to the PWA, in [Web]. The Expo
// transport was removed on 2026-08-10 together with the native client that was
// its only audience; see [DefaultEndpoint] for the one trace of it that is
// deliberately still here.
//
// # The one rule
//
// The body sent to a push service is exactly:
//
//	{"title": "New activity"}
//
// No amount, no merchant, no count, no category, no currency, ever. This is not
// a style preference:
//
//   - A notification is rendered on a LOCK SCREEN, which is the one surface
//     that is visible without the device being unlocked.
//   - It travels through a third-party push service — Apple, Google, Mozilla,
//     whoever the subscription names. None of those hops is covered by the
//     end-to-end encryption spec §3.4 promises over the op log, so anything put
//     in a notification has left the envelope the rest of this design is built
//     to keep closed.
//   - Even a COUNT is content: "3 new transactions" on a Tuesday afternoon is a
//     spending-frequency signal, and it is exactly the kind of field that gets
//     added later because it seems harmless in isolation.
//
// TestTheWebPushPayloadIsContentFree pins the payload field-for-field rather
// than checking for the absence of particular strings, because absence-checking
// only catches the leaks somebody already thought of. [WebTitle] is the whole
// content, and the client renders its own copy of that string rather than
// trusting the server's.
//
// # What the one rule does NOT cover: timing
//
// The rule above is about CONTENT, and content is only half of what leaves the
// box on this path. The other half cannot be fixed by any payload rule and was
// accepted deliberately (spec §2, §3.8 and Decision 4): the existence and the
// timestamp of each request are themselves the signal.
//
// Concretely, per trusted append, the push service learns the precise moment a
// user received a bank transaction and this deployment's source IP. It learns
// that for every user of this deployment. Frequency, time of day and burstiness
// of somebody's spending are all recoverable from that series without a single
// byte of the payload being read.
//
// A second consequence, worth naming because it is not obvious: the fan-out is
// a tight sequential loop with no jitter, so a user's N devices are notified
// within milliseconds of each other from one IP. That lets a push service GROUP
// a user's devices even though no request names the user. Do not "fix" this by
// delaying — §3.8 requires the notification be immediate, and trading the
// product's whole value for a correlation the service can also get from the
// subscription registry is a bad trade. It is disclosed, not mitigated.
//
// # Why the payload contract is pinned this hard
//
// The call site is exactly one (the ingest pipeline, on a hot-stream append)
// and [Notifier.Notify] is handed a user id and nothing else, so there is no
// code path in this package that COULD interpolate a merchant or an amount.
// That is the design: adding the merchant name to a notification has to be a
// change to this package, not a parameter somebody threads through.
package pushv2

import (
	"context"

	"github.com/google/uuid"
)

// DefaultEndpoint was Expo's push service, and is retained as an inert
// constant.
//
// The Expo notifier is gone, but `[push] expo_url` is still a key the v2
// config loader accepts — it has to be, because the loader HARD-REJECTS a TOML
// carrying an unknown key, so removing the field would stop `ledgerd` booting
// against any deployed config that still sets it. Config.validatePush still
// rails the value when it is set, and its comment names this constant as the
// documented default. Deleting this would leave that comment pointing at
// nothing.
//
// Nothing sends to it. If the config keys are ever retired, retire this with
// them.
const DefaultEndpoint = "https://exp.host/--/api/v2/push/send"

// MaxDevicesPerUser bounds the fan-out of one Notify. A user with more
// registered devices than this has a client bug or a subscription that is never
// deleted, and neither is a reason to make one transaction cost an unbounded
// number of outbound requests.
//
// It is exported because the API enforces the SAME cap at registration, with
// the same ordering, so that the set of devices a registration keeps is exactly
// the set this package would notify. Two independent constants would eventually
// disagree, and the symptom of disagreement is a device that is stored and
// never notified — silent, and indistinguishable from push being broken.
//
// Which devices the cap keeps is the part that had to be fixed rather than
// tuned: see [Web.Notify]'s ordering.
const MaxDevicesPerUser = 20

// Disabled is the no-op pusher, and the default. It satisfies the same
// interface as [Web], so the wiring in cmd/ledgerd is one branch and the
// pipeline has no idea which one it holds.
//
// It stays as the zero case rather than being replaced by an empty [Multi] —
// which would also be a valid no-op — so that "push is off" reads the same in a
// log line and in a stack trace as it always has.
type Disabled struct{}

// Notify does nothing, successfully.
func (Disabled) Notify(context.Context, uuid.UUID) error { return nil }
