package norm

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Stage 10 of the normalizer: inline-forward unwrapping.
//
// Gmail forwarding is the primary onboarding path, so almost every message a
// new user contributes arrives wrapped in a forwarding client's preamble. The
// transaction is described by the INNER message, and three things follow from
// that, none of them cosmetic:
//
//   - The inner Subject is the effective subject. The ENBD "Transaction advice"
//     template reads the account last4 ONLY from the subject, because the body
//     masks the account number. Keeping the outer envelope subject silently
//     drops last4 on every forwarded ENBD alert.
//   - The inner Date is the effective date. A forward that arrives days after
//     the purchase would otherwise date the transaction to the forward.
//   - The inner From is CONTENT, never trust. Everything below reads
//     attacker-authored body text.
//
// Every regexp here spells out " *" rather than `\s*`. Go's RE2 `\s` is
// [\t\n\f\r ] while JavaScript's is a much larger Unicode set that includes
// U+00A0 and U+FEFF, so `\s` is exactly the kind of silent cross-language
// disagreement this contract exists to prevent.

// forwardMarkerRe matches the line introducing an inline-forwarded message:
// Apple Mail ("Begin forwarded message:") and Gmail ("---------- Forwarded
// message ---------"), case-insensitively.
var forwardMarkerRe = regexp.MustCompile(`(?i)^ *(begin forwarded message:|-+ *forwarded message *-+) *$`)

// fwdSubjectRe strips a leading Fwd:/FW:/Fw: from a subject.
var fwdSubjectRe = regexp.MustCompile(`(?i)^ *(fwd?|fw) *: *`)

// fwdHeaderLineRe matches a forwarded-header line, capturing the label and any
// same-line value. Apple Mail puts the value on the NEXT line (empty group 2);
// Gmail puts it on the same line.
var fwdHeaderLineRe = regexp.MustCompile(`(?i)^ *(from|to|subject|date|reply-to|cc|sent) *: *(.*)$`)

// forward is what stage 10 recovers. Every field is content read out of the
// body; none of it is an identity claim.
type forward struct {
	From    string // inner From when recovered, else the message's own
	Subject string // inner Subject when recovered, else the message's own with Fwd: stripped
	Date    string // the raw inner Date value; "" when none was recovered
	Body    string // the text with the preamble and header block removed
	// Found reports that a forward MARKER line was present. It does NOT mean
	// inner headers were recovered: 50 of the 56 forwards in the v1 corpus are
	// ">"-quoted text/plain, where the marker is unquoted but every header line
	// is, so Found is true and From/Subject/Date all stay at their defaults.
	Found bool
}

// unwrapForward runs stage 10 over the joined, normalized text.
func unwrapForward(from, subject, body string) forward {
	return unwrapForwardWith(from, subject, body, trimExplicit)
}

// unwrapForwardWith is stage 10 with the trim as a parameter. See [trimmer]:
// production always passes trimExplicit, and only the corpus equivalence gate
// passes anything else.
func unwrapForwardWith(from, subject, body string, trim trimmer) forward {
	lines := strings.Split(body, "\n")

	marker := -1
	for i, l := range lines {
		if forwardMarkerRe.MatchString(l) {
			marker = i
			break
		}
	}
	if marker == -1 {
		// Not a forward. Strip a leading Fwd:/FW: from the subject so a
		// template's SubjectContains still matches; the body is untouched.
		return forward{
			From:    from,
			Subject: fwdSubjectRe.ReplaceAllString(subject, ""),
			Body:    body,
		}
	}

	recFrom, recSubject, recDate := "", "", ""
	end := marker + 1 // first line of the original body, after the header block
	sawHeader := false
	for i := marker + 1; i < len(lines); {
		m := fwdHeaderLineRe.FindStringSubmatch(lines[i])
		if m == nil {
			if sawHeader {
				break // header block ended; the original body starts at lines[i]
			}
			i++ // skip preamble/blank noise between the marker and the first header
			continue
		}
		sawHeader = true
		label := strings.ToLower(m[1])
		value := trim(m[2])
		if value == "" { // Apple Mail: the value is on the next non-empty line
			j := i + 1
			for j < len(lines) && trim(lines[j]) == "" {
				j++
			}
			if j < len(lines) {
				value = trim(lines[j])
				i = j
			}
		}
		switch label {
		case "from":
			recFrom = value
		case "subject":
			recSubject = value
		case "date":
			recDate = value
		}
		i++
		end = i
	}

	out := forward{From: from, Subject: subject, Date: recDate, Body: body, Found: true}
	if recFrom != "" {
		out.From = recFrom
	}
	if recSubject != "" {
		out.Subject = recSubject
	} else {
		out.Subject = fwdSubjectRe.ReplaceAllString(subject, "")
	}
	if sawHeader && end < len(lines) {
		out.Body = trim(strings.Join(lines[end:], "\n"))
	}
	return out
}

// fwdDateLayouts covers the Date formats forwarding clients emit: iCloud
// webmail, Gmail, and the Apple Mail app (whose trailing zone token, e.g.
// "GMT+4", is stripped before matching — forward dates are treated as naive,
// i.e. the parsed value is read as UTC).
//
// The list is CLOSED at these four. It notably does not cover the 12-hour
// WITH-seconds shape the Apple Mail iOS app emits ("18 June 2026 at 7:33:38 PM
// GST"), which three corpus messages use and which therefore falls back to the
// arrival time. Adding a layout changes which messages get a body-derived date
// and is a normalizer VERSION bump, not a bug fix.
var fwdDateLayouts = []string{
	"Jan 2, 2006 at 3:04 PM",
	"Mon, Jan 2, 2006 at 3:04 PM",
	"2 January 2006 at 15:04:05",
	"2 January 2006 at 15:04",
}

// nbspReplacer normalizes the no-break space variants mail clients insert
// before AM/PM — Apple Mail's narrow no-break space (U+202F) on recent OSes,
// and U+00A0, which also appears in the wild — to plain spaces so the layouts
// above can match.
var nbspReplacer = strings.NewReplacer("\u202f", " ", "\u00a0", " ")

// parseForwardDate parses a forwarded-header Date value recovered by
// unwrapForward. The returned time is naive, read as UTC.
func parseForwardDate(s string) (time.Time, error) {
	return parseForwardDateWith(s, trimExplicit)
}

// parseForwardDateWith is parseForwardDate with the trim as a parameter. See
// [trimmer].
func parseForwardDateWith(s string, trim trimmer) (time.Time, error) {
	s = nbspReplacer.Replace(trim(s))
	candidates := []string{s}
	// Retry once with the final space-delimited token removed, which is how a
	// trailing zone name ("GST", "GMT+4") is dropped.
	if i := strings.LastIndex(s, " "); i > 0 {
		candidates = append(candidates, trim(s[:i]))
	}
	for _, c := range candidates {
		for _, layout := range fwdDateLayouts {
			if t, err := time.Parse(layout, c); err == nil {
				return t, nil
			}
		}
	}
	return time.Time{}, fmt.Errorf("norm: unrecognized forward date %q", s)
}
