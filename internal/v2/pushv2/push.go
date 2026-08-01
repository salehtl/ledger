// Package pushv2 delivers content-free push notifications through Expo.
//
// # The one rule
//
// The body sent to Expo is exactly:
//
//	{"to": "<token>", "title": "New transaction", "body": ""}
//
// No amount, no merchant, no count, no category, no currency, ever. This is not
// a style preference and it is not deferrable to "when the app exists":
//
//   - A notification is rendered on a LOCK SCREEN, which is the one surface
//     that is visible without the device being unlocked.
//   - It travels through Expo, then through Apple's APNs or Google's FCM. None
//     of those hops is covered by the end-to-end encryption spec §3.4 promises
//     over the op log, so anything put in a notification has left the envelope
//     the rest of this design is built to keep closed.
//   - Even a COUNT is content: "3 new transactions" on a Tuesday afternoon is a
//     spending-frequency signal, and it is exactly the kind of field that gets
//     added later because it seems harmless in isolation.
//
// TestPushPayloadIsContentFree pins the payload field-for-field rather than
// checking for the absence of particular strings, because absence-checking only
// catches the leaks somebody already thought of.
//
// # What the one rule does NOT cover: timing
//
// The rule above is about CONTENT, and content is only half of what leaves the
// box on this path. The other half cannot be fixed by any payload rule and was
// accepted deliberately (spec §2, §3.8 and Decision 4): the existence and the
// timestamp of each request are themselves the signal.
//
// Concretely, per trusted append, Expo — and after it Apple's APNs or Google's
// FCM — learns the precise moment a user received a bank transaction, this
// deployment's source IP, and (when set) the Expo access token identifying the
// project. It learns that for every user of this deployment. Frequency, time of
// day and burstiness of somebody's spending are all recoverable from that
// series without a single byte of the payload being read.
//
// A second consequence, worth naming because it is not obvious: the fan-out is
// a tight sequential loop with no jitter, so a user's N devices are notified
// within milliseconds of each other from one IP under one credential. That lets
// Expo GROUP a user's devices even though no request names the user. Do not
// "fix" this by delaying — §3.8 requires the notification be immediate, and
// trading the product's whole value for a correlation Expo can also get from
// the token registry is a bad trade. It is disclosed, not mitigated.
//
// # Dead tokens are not reaped, and that is a Phase 2 gap
//
// Expo's delivery model has two phases. The TICKET is the immediate answer to
// the POST; the RECEIPT, fetched later from /push/getReceipts by ticket id, is
// where APNs and FCM report that a device has gone away. This package reads the
// ticket and discards its id, so it detects DeviceNotRegistered only in the
// (rare) case Expo reports it immediately, and the ordinary uninstall — which
// arrives in a receipt — is never seen. Nothing here reaps a token because its
// app was deleted.
//
// That is stated rather than fixed because fixing it means persisting ticket
// ids, a poller, and a taxonomy of Expo errors that cannot be verified against
// anything but the real service — and no test in this repo has ever contacted
// exp.host. Phase 2, which ships the client and turns push on, owns it.
//
// What it costs, now that the cost is bounded: an uninstalled app leaves a row
// that is POSTed to on every transaction forever, wasting one request per
// append. It is no longer a privacy problem, which is the part that mattered:
// after 00019 a token is deleted when its device key is revoked, when its
// session is revoked, when the user deletes it from the device list, when the
// per-user cap evicts it, and when the account is purged. Uninstall is the one
// disowning gesture that no longer has a server-side signal, and an uninstalled
// app renders nothing.
//
// # Why this exists before there is an app to receive it
//
// cfg.Push.Enabled defaults to false, so what Phase 1 actually wires is
// [Disabled]. Building the real one now is deliberate: the call site (exactly
// one, in the ingest pipeline, on a hot-stream append) and the content-free
// contract get pinned by tests while there is no product pressure to bend them.
// Adding the merchant name to a notification is a five-character change on the
// day somebody asks for it.
package pushv2

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultEndpoint is Expo's push service.
const DefaultEndpoint = "https://exp.host/--/api/v2/push/send"

// Title is the entire content of a notification. It is a constant so that
// "make it say what was bought" is a change to this package rather than a
// parameter somebody threads through.
const Title = "New transaction"

// Platforms are the values push_tokens.platform admits, mirrored by that
// column's CHECK constraint. Nothing branches on the value; it exists so an
// operator can tell an APNs problem from an FCM one.
var Platforms = []string{"ios", "android"}

// MaxDevicesPerUser bounds the fan-out of one Notify. A user with more
// registered devices than this has a client bug or a token that is never
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
// tuned: see [Expo.Notify]'s ordering.
const MaxDevicesPerUser = 20

// deviceNotRegistered is the ONE Expo error that means a token will never work
// again. Every other failure is transient as far as this package is concerned.
const deviceNotRegistered = "DeviceNotRegistered"

// defaultTimeout bounds one delivery. Expo being slow must not hold the ingest
// path open: the transaction is already committed by the time Notify is called.
const defaultTimeout = 10 * time.Second

// Disabled is the no-op pusher, and the Phase 1 default. It satisfies the same
// interface as [Expo], so the wiring in cmd/ledgerd is one branch and the
// pipeline has no idea which one it holds.
type Disabled struct{}

// Notify does nothing, successfully.
func (Disabled) Notify(context.Context, uuid.UUID) error { return nil }

// Expo delivers through Expo's push service.
type Expo struct {
	// Pool reads push_tokens. Required.
	Pool *pgxpool.Pool
	// Endpoint defaults to DefaultEndpoint.
	Endpoint string
	// HTTP defaults to a client with defaultTimeout.
	HTTP *http.Client
	// AccessToken is Expo's optional enhanced-security credential. It rides in
	// an Authorization header, never in the body.
	AccessToken string
	// Logf receives delivery failures. Defaults to log.Printf.
	Logf func(format string, args ...any)
}

func (e *Expo) logf(format string, args ...any) {
	if e.Logf != nil {
		e.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

func (e *Expo) endpoint() string {
	if e.Endpoint != "" {
		return e.Endpoint
	}
	return DefaultEndpoint
}

func (e *Expo) client() *http.Client {
	if e.HTTP != nil {
		return e.HTTP
	}
	return &http.Client{Timeout: defaultTimeout}
}

// message is the whole wire model. It is a struct with three fields and no
// omitempty, so an empty body is SENT as "" rather than dropped, and a fourth
// field cannot be added by accident somewhere else in the process.
type message struct {
	To    string `json:"to"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

// Notify tells every device this user has registered that something arrived.
//
// It returns an error only for a failure to READ the token list — the caller
// (the ingest pipeline) ignores that too, but a store failure is worth
// distinguishing from "the notification did not go out", which is logged and
// swallowed. A push is a courtesy: the transaction is already in the op log and
// the client will see it on its next sync whether or not Expo answered.
func (e *Expo) Notify(ctx context.Context, userID uuid.UUID) error {
	if e == nil || e.Pool == nil {
		return fmt.Errorf("pushv2: no pool")
	}
	if userID == uuid.Nil {
		return fmt.Errorf("pushv2: user id is zero")
	}
	tokens, err := e.tokens(ctx, userID)
	if err != nil {
		return err
	}
	for _, tok := range tokens {
		dead, err := e.send(ctx, tok)
		switch {
		case err != nil:
			// Logged, never returned. The token is left alone: a network error
			// or a 500 says nothing about whether the device still exists.
			e.logf("pushv2: notifying user %s: %v", userID, err)
		case dead:
			// The one case that is permanent. Left in place it would produce an
			// outbound request per transaction, forever, for a device that
			// uninstalled the app.
			if err := e.forget(ctx, userID, tok); err != nil {
				e.logf("pushv2: forgetting a dead device for user %s: %v", userID, err)
			}
		}
	}
	return nil
}

// fanoutOrder is the order devices are notified in, and the order the cap is
// applied in. DESCENDING by registration time: the cap's casualty must always
// be a device the user stopped using, never the one in their hand.
//
// It was ascending, and that was a real defect rather than an arbitrary choice.
// With `ORDER BY created_at` and `LIMIT 20`, a user whose 21st device was their
// current phone had that phone excluded from every notification — registration
// still answered 204, the token sat in the table, and the feature was simply
// off with nothing saying so. A stale row cannot be told from a live one by
// this query, so the tiebreak has to be "most recently registered wins".
//
// api.handleRegisterPushToken evicts by the identical expression. If you change
// one, change both; TestTheCapKeepsTheSameDevicesTheAPIKept is what notices.
const fanoutOrder = `ORDER BY created_at DESC, token DESC`

func (e *Expo) tokens(ctx context.Context, userID uuid.UUID) ([]string, error) {
	// LIMIT is the cap PLUS ONE, deliberately: it is the difference between
	// "twenty devices" and "at least twenty-one devices", and the second is the
	// one worth a log line. A cap that silently drops a user's devices is how
	// I2 stayed invisible; this makes exceeding it an event.
	rows, err := e.Pool.Query(ctx,
		`SELECT token FROM push_tokens WHERE user_id = $1 `+fanoutOrder+` LIMIT $2`,
		userID, MaxDevicesPerUser+1)
	if err != nil {
		return nil, fmt.Errorf("pushv2: read push tokens: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, fmt.Errorf("pushv2: read push tokens: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("pushv2: read push tokens: %w", err)
	}
	if len(out) > MaxDevicesPerUser {
		// Registration is supposed to have evicted down to the cap already, so
		// reaching here means the two enforcement points disagree or something
		// wrote this table directly. Either way an operator should hear it.
		e.logf("pushv2: user %s has more than %d registered devices; notifying the %d most recent only",
			userID, MaxDevicesPerUser, MaxDevicesPerUser)
		out = out[:MaxDevicesPerUser]
	}
	return out, nil
}

func (e *Expo) forget(ctx context.Context, userID uuid.UUID, token string) error {
	_, err := e.Pool.Exec(ctx,
		`DELETE FROM push_tokens WHERE user_id = $1 AND token = $2`, userID, token)
	return err
}

// send delivers one notification and reports whether the token is permanently
// dead.
func (e *Expo) send(ctx context.Context, token string) (dead bool, err error) {
	body, err := json.Marshal(message{To: token, Title: Title, Body: ""})
	if err != nil {
		return false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.endpoint(), bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if e.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+e.AccessToken)
	}
	resp, err := e.client().Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	// Bounded: the response is a receipt, and an endpoint that answers with a
	// gigabyte must not be able to make this allocate one.
	raw, rerr := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode/100 != 2 {
		return false, fmt.Errorf("expo answered %d", resp.StatusCode)
	}
	if rerr != nil {
		return false, rerr
	}
	return isDead(raw)
}

// receipt is the part of Expo's answer this package reads. `data` is an ARRAY
// for a batched POST and an OBJECT for a single one, so it is decoded twice
// rather than assumed: reading only one shape would make every receipt
// unreadable and every dead device permanent.
type receipt struct {
	Status  string `json:"status"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
}

func isDead(raw []byte) (bool, error) {
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return false, fmt.Errorf("expo answered something that is not JSON: %w", err)
	}
	if len(env.Data) == 0 {
		return false, fmt.Errorf("expo answered with no receipt")
	}
	var many []receipt
	if err := json.Unmarshal(env.Data, &many); err != nil {
		var one receipt
		if err := json.Unmarshal(env.Data, &one); err != nil {
			return false, fmt.Errorf("expo receipt is neither an object nor an array: %w", err)
		}
		many = []receipt{one}
	}
	for _, r := range many {
		if r.Details.Error == deviceNotRegistered {
			return true, nil
		}
		if r.Status != "" && r.Status != "ok" {
			return false, fmt.Errorf("expo rejected the message: %s", r.Details.Error)
		}
	}
	return false, nil
}
