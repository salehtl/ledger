package parse

import (
	"bytes"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/emersion/go-message"
	_ "github.com/emersion/go-message/charset" // register common charsets
)

var (
	tagRe = regexp.MustCompile(`(?s)<[^>]+>`)
	wsRe  = regexp.MustCompile(`[ \t\x{00a0}]+`)
)

// BodyText parses a raw RFC822 message, extracts the best text part (preferring
// text/html, falling back to text/plain), decodes transfer-encoding + charset,
// and strips HTML to normalized plain text with one value per line.
func BodyText(raw []byte) (string, error) {
	ent, err := message.Read(bytes.NewReader(raw))
	if err != nil && !message.IsUnknownCharset(err) && !message.IsUnknownEncoding(err) {
		return "", fmt.Errorf("read message: %w", err)
	}
	htmlBody, plainBody := "", ""
	walk := func(e *message.Entity) {
		ct, _, _ := e.Header.ContentType()
		b, rerr := io.ReadAll(e.Body)
		if rerr != nil {
			return
		}
		switch ct {
		case "text/html":
			if htmlBody == "" {
				htmlBody = string(b)
			}
		case "text/plain":
			if plainBody == "" {
				plainBody = string(b)
			}
		}
	}
	if mr := ent.MultipartReader(); mr != nil {
		for {
			part, perr := mr.NextPart()
			if perr == io.EOF {
				break
			}
			if perr != nil {
				return "", fmt.Errorf("next part: %w", perr)
			}
			if inner := part.MultipartReader(); inner != nil {
				for {
					p2, e2 := inner.NextPart()
					if e2 == io.EOF {
						break
					}
					if e2 != nil {
						return "", fmt.Errorf("next inner part: %w", e2)
					}
					walk(p2)
				}
				continue
			}
			walk(part)
		}
	} else {
		walk(ent)
	}

	chosen := htmlBody
	stripped := chosen != ""
	if chosen == "" {
		chosen = plainBody
		stripped = false
	}
	if chosen == "" {
		return "", fmt.Errorf("no text/html or text/plain part found")
	}
	if stripped {
		chosen = stripHTML(chosen)
	}
	return normalize(chosen), nil
}

func stripHTML(s string) string {
	s = regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`).ReplaceAllString(s, " ")
	s = regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`).ReplaceAllString(s, " ")
	s = strings.ReplaceAll(s, "<br>", "\n")
	s = strings.ReplaceAll(s, "<br/>", "\n")
	s = strings.ReplaceAll(s, "</p>", "\n")
	s = strings.ReplaceAll(s, "</tr>", "\n")
	s = strings.ReplaceAll(s, "</div>", "\n")
	s = tagRe.ReplaceAllString(s, "\n")
	return s
}

var entities = strings.NewReplacer("&nbsp;", " ", "&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", "\"", "&#39;", "'")

func normalize(s string) string {
	s = entities.Replace(s)
	s = wsRe.ReplaceAllString(s, " ")
	var lines []string
	for _, l := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			lines = append(lines, t)
		}
	}
	return strings.Join(lines, "\n")
}
