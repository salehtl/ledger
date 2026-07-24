package parse

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// forwardMarkerRe matches the line introducing an inline-forwarded message:
// Apple Mail ("Begin forwarded message:") and Gmail ("---------- Forwarded
// message ---------"), case-insensitively.
var forwardMarkerRe = regexp.MustCompile(`(?i)^\s*(begin forwarded message:|-+\s*forwarded message\s*-+)\s*$`)

// fwdSubjectRe strips a leading Fwd:/FW: from a subject.
var fwdSubjectRe = regexp.MustCompile(`(?i)^\s*(fwd?|fw)\s*:\s*`)

// fwdHeaderLineRe matches a forwarded-header line, capturing the label and any
// same-line value. Apple Mail puts the value on the NEXT line (empty group 2);
// Gmail puts it on the same line.
var fwdHeaderLineRe = regexp.MustCompile(`(?i)^\s*(from|to|subject|date|reply-to|cc|sent)\s*:\s*(.*)$`)

// Unwrap detects an inline-forwarded bank email and recovers the ORIGINAL
// sender, subject, and Date header from the forwarded header block, returning a
// body with the forwarder's preamble and header block removed. A non-forwarded
// email is returned unchanged with an empty date. Input body is the
// HTML-stripped text from BodyText.
func Unwrap(from, subject, body string) (string, string, string, string) {
	lines := strings.Split(body, "\n")

	marker := -1
	for i, l := range lines {
		if forwardMarkerRe.MatchString(l) {
			marker = i
			break
		}
	}
	if marker == -1 {
		// No forward marker. Strip a leading Fwd:/FW: from the subject if
		// present (so a future template Matches can use it); otherwise return
		// the inputs unchanged. Body is untouched either way.
		if fwdSubjectRe.MatchString(subject) {
			return from, fwdSubjectRe.ReplaceAllString(subject, ""), "", body
		}
		return from, subject, "", body
	}

	recFrom, recSubject, recDate := "", "", ""
	end := marker + 1 // first line of the original body (after the header block)
	sawHeader := false
	for i := marker + 1; i < len(lines); {
		m := fwdHeaderLineRe.FindStringSubmatch(lines[i])
		if m == nil {
			if sawHeader {
				break // header block ended; original body starts at lines[i]
			}
			i++ // skip preamble/blank noise between marker and first header
			continue
		}
		sawHeader = true
		label := strings.ToLower(m[1])
		value := strings.TrimSpace(m[2])
		if value == "" { // Apple Mail: value is on the next non-empty line
			j := i + 1
			for j < len(lines) && strings.TrimSpace(lines[j]) == "" {
				j++
			}
			if j < len(lines) {
				value = strings.TrimSpace(lines[j])
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

	effFrom, effSubject, effBody := from, subject, body
	if recFrom != "" {
		effFrom = recFrom
	}
	if recSubject != "" {
		effSubject = recSubject
	} else {
		effSubject = fwdSubjectRe.ReplaceAllString(subject, "")
	}
	if sawHeader && end < len(lines) {
		effBody = strings.TrimSpace(strings.Join(lines[end:], "\n"))
	}
	return effFrom, effSubject, recDate, effBody
}

// fwdDateLayouts covers the Date formats forwarding clients emit: iCloud
// webmail, Gmail, and the Apple Mail app (whose trailing zone token, e.g.
// "GMT+4", is stripped before matching — forward dates are treated as naive).
var fwdDateLayouts = []string{
	"Jan 2, 2006 at 3:04 PM",
	"Mon, Jan 2, 2006 at 3:04 PM",
	"2 January 2006 at 15:04:05",
	"2 January 2006 at 15:04",
}

// ParseForwardDate parses a forwarded-header Date value recovered by Unwrap.
func ParseForwardDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	candidates := []string{s}
	if i := strings.LastIndex(s, " "); i > 0 {
		candidates = append(candidates, strings.TrimSpace(s[:i]))
	}
	for _, c := range candidates {
		for _, layout := range fwdDateLayouts {
			if t, err := time.Parse(layout, c); err == nil {
				return t, nil
			}
		}
	}
	return time.Time{}, fmt.Errorf("unrecognized forward date %q", s)
}
