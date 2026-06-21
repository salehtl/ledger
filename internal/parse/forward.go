package parse

import (
	"regexp"
	"strings"
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
// sender and subject from the forwarded header block, returning a body with the
// forwarder's preamble and header block removed. A non-forwarded email is
// returned unchanged. Input body is the HTML-stripped text from BodyText.
func Unwrap(from, subject, body string) (string, string, string) {
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
			return from, fwdSubjectRe.ReplaceAllString(subject, ""), body
		}
		return from, subject, body
	}

	recFrom, recSubject := "", ""
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
	return effFrom, effSubject, effBody
}
