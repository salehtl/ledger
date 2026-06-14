package ingest

import (
	"context"
	"fmt"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"ledger/internal/config"
)

// imapDialer opens authenticated, read-only IMAP connections from config.
type imapDialer struct {
	cfg config.IMAPConfig
}

// NewIMAPDialer returns a Dialer backed by go-imap/v2.
func NewIMAPDialer(cfg config.IMAPConfig) Dialer { return &imapDialer{cfg: cfg} }

func (d *imapDialer) Dial(ctx context.Context) (Mailbox, error) {
	c, err := imapclient.DialTLS(d.cfg.Addr(), nil)
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
	return &imapMailbox{c: c, folder: d.cfg.Folder}, nil
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
