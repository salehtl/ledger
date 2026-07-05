package ingest

import (
	"context"
	"fmt"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"ledger/internal/config"
)

// imapDialer opens authenticated, read-only IMAP connections from config.
// It implements both Dialer (per-sync connections) and IdleDialer (dedicated
// IDLE connections that wake the worker on new mail).
type imapDialer struct {
	cfg config.IMAPConfig
}

// NewIMAPDialer returns a Dialer backed by go-imap/v2. The returned value
// also implements IdleDialer (checked via type assertion in main).
func NewIMAPDialer(cfg config.IMAPConfig) Dialer { return &imapDialer{cfg: cfg} }

// connect dials TLS and authenticates. opts may carry a unilateral-data
// handler (required at dial time by go-imap for IDLE notifications); nil is
// fine for plain sync connections.
func (d *imapDialer) connect(opts *imapclient.Options) (*imapclient.Client, error) {
	c, err := imapclient.DialTLS(d.cfg.Addr(), opts)
	if err != nil {
		return nil, fmt.Errorf("imap dial %s: %w", d.cfg.Addr(), err)
	}
	switch d.cfg.Auth {
	case "app_password", "":
		if err := c.Login(d.cfg.Username, d.cfg.AppPassword).Wait(); err != nil {
			_ = c.Close()
			return nil, fmt.Errorf("imap login: %w", err)
		}
	case "oauth2":
		_ = c.Close()
		return nil, fmt.Errorf("imap auth oauth2 not implemented yet; use app_password")
	default:
		_ = c.Close()
		return nil, fmt.Errorf("imap: unknown auth %q", d.cfg.Auth)
	}
	return c, nil
}

func (d *imapDialer) Dial(ctx context.Context) (Mailbox, error) {
	c, err := d.connect(nil)
	if err != nil {
		return nil, err
	}
	return &imapMailbox{c: c, folder: d.cfg.Folder}, nil
}

// DialIdle opens a connection whose sole job is to park in IDLE and report
// new-mail activity. The unilateral-data handler must be registered at dial
// time, and the folder is selected read-only (EXAMINE) — IDLE never weakens
// the read-only guarantee.
func (d *imapDialer) DialIdle(ctx context.Context) (Waiter, error) {
	notify := make(chan struct{}, 1)
	opts := &imapclient.Options{
		UnilateralDataHandler: &imapclient.UnilateralDataHandler{
			Mailbox: func(data *imapclient.UnilateralDataMailbox) {
				if data.NumMessages != nil {
					select {
					case notify <- struct{}{}:
					default:
					}
				}
			},
		},
	}
	c, err := d.connect(opts)
	if err != nil {
		return nil, err
	}
	if _, err := c.Select(d.cfg.Folder, &imap.SelectOptions{ReadOnly: true}).Wait(); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("idle examine %q: %w", d.cfg.Folder, err)
	}
	return &idleWaiter{c: c, notify: notify}, nil
}

// idleWaiter is one parked IDLE connection.
type idleWaiter struct {
	c      *imapclient.Client
	notify chan struct{}
}

func (iw *idleWaiter) Wait(ctx context.Context, timeout time.Duration) error {
	cmd, err := iw.c.Idle()
	if err != nil {
		return fmt.Errorf("idle: %w", err)
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var reason error
	select {
	case <-ctx.Done():
		reason = ctx.Err()
	case <-iw.notify: // server pushed EXISTS: new mail
	case <-timer.C: // fallback heartbeat: sync anyway
	}
	if err := cmd.Close(); err != nil && reason == nil {
		return fmt.Errorf("idle close: %w", err)
	}
	return reason
}

func (iw *idleWaiter) Close() error {
	_ = iw.c.Logout().Wait()
	return iw.c.Close()
}

type imapMailbox struct {
	c      *imapclient.Client
	folder string
}

func (m *imapMailbox) Examine(ctx context.Context) (uint32, error) {
	// ReadOnly = true makes Select issue EXAMINE: the server forbids any mutation.
	data, err := m.c.Select(m.folder, &imap.SelectOptions{ReadOnly: true}).Wait()
	if err != nil {
		return 0, fmt.Errorf("examine %q: %w", m.folder, err)
	}
	return data.UIDValidity, nil
}

func (m *imapMailbox) ListUIDs(ctx context.Context) ([]uint32, error) {
	// Empty criteria == SEARCH ALL.
	data, err := m.c.UIDSearch(&imap.SearchCriteria{}, nil).Wait()
	if err != nil {
		return nil, fmt.Errorf("uid search: %w", err)
	}
	uids := data.AllUIDs()
	out := make([]uint32, len(uids))
	for i, u := range uids {
		out[i] = uint32(u)
	}
	return out, nil
}

func (m *imapMailbox) Fetch(ctx context.Context, uid uint32) (Message, error) {
	section := &imap.FetchItemBodySection{} // zero value == whole body (BODY[])
	opts := &imap.FetchOptions{
		Envelope:     true,
		InternalDate: true,
		UID:          true,
		BodySection:  []*imap.FetchItemBodySection{section},
	}
	msgs, err := m.c.Fetch(imap.UIDSetNum(imap.UID(uid)), opts).Collect()
	if err != nil {
		return Message{}, fmt.Errorf("fetch uid %d: %w", uid, err)
	}
	if len(msgs) == 0 {
		return Message{}, fmt.Errorf("fetch uid %d: no message returned", uid)
	}
	buf := msgs[0]
	out := Message{UID: uid, Raw: buf.FindBodySection(section)}
	if buf.Envelope != nil {
		out.Subject = buf.Envelope.Subject
		out.ReceivedAt = buf.Envelope.Date
		if len(buf.Envelope.From) > 0 {
			out.From = buf.Envelope.From[0].Addr()
		}
	}
	if !buf.InternalDate.IsZero() {
		out.ReceivedAt = buf.InternalDate
	}
	return out, nil
}

func (m *imapMailbox) Close() error {
	_ = m.c.Logout().Wait()
	return m.c.Close()
}
