-- +goose Up

-- Two corrections to 00008, both found by Task 26 landing beside it.
--
-- # 1. The forwarder list was a list of the wrong thing
--
-- 00008's refusal list held the domains users have MAILBOXES at — gmail.com,
-- icloud.com. But the value it guards, sender_allowlist.domain at scope
-- 'outer', is compared against origin.Origin.Outer, which holds the domain that
-- SIGNED or SEALED the message: Google signs as google.com, Microsoft as
-- microsoft.com. So the constraint refused 'gmail.com' and cheerfully accepted
-- 'google.com' — spec §3.2:51's forwarder-allowlist bypass with a different
-- spelling, made durable in a CHECK.
--
-- The list is now origin.ForwarderDomains, which owns the definition of what a
-- forwarder is because it is the package that decides trust. quarantine calls
-- origin.IsForwarderDomain rather than keeping a copy, and
-- TestTheSQLForwarderListMatchesOrigin holds this constraint to that list.
--
-- Matching is PERMISSIVE — a subdomain counts, which is why this is a regex and
-- not an IN list. mail.google.com is as much a forwarder as google.com, and the
-- error directions are not symmetric: over-inclusion costs a user one refused
-- outer entry, under-inclusion is the bypass.
ALTER TABLE sender_allowlist DROP CONSTRAINT sender_allowlist_no_forwarder_as_outer;
ALTER TABLE sender_allowlist ADD CONSTRAINT sender_allowlist_no_forwarder_as_outer CHECK (
  scope <> 'outer' OR domain !~ '(^|\.)(apple\.com|fastmail\.com|gmail\.com|google\.com|googlemail\.com|hotmail\.com|icloud\.com|live\.com|mac\.com|me\.com|messagingengine\.com|microsoft\.com|outlook\.com|proton\.me|protonmail\.ch|protonmail\.com|yahoo\.com|zoho\.com)$'
);

-- # 2. The SMTP envelope sender was not stored
--
-- origin.ResolveWithEnvelope needs the return path to decide whether a passing
-- signature is ALIGNED with the sender (outer) or is a bank's signature
-- surviving a forward (inner). The envelope arrives out of band, at MAIL FROM:
-- it is nowhere in the message bytes, so a quarantine row that keeps only the
-- blob has destroyed it. Task 30 re-runs ingest over held mail when a sender is
-- confirmed, and without this column every reprocessed forward would resolve
-- with an empty envelope and could stop attesting its inner origin — the mail
-- would come back LESS trusted than when it arrived, for no reason the user
-- could see.
--
-- It is an assertion, never evidence: anyone who can open a TCP connection
-- writes it. It is stored so a re-resolve sees exactly what the first resolve
-- saw, and for no other purpose — nothing keys on it, and the sync channel
-- deliberately does not render it (§3.2:55: the trust sheet shows verified
-- domains, never attacker-written text).
--
-- '' is the null sender (<>), which is legitimate and common for bounces.
ALTER TABLE quarantine ADD COLUMN envelope_from text NOT NULL DEFAULT ''
  CONSTRAINT quarantine_envelope_from_is_a_path CHECK (
    -- RFC 5321 §4.5.3.1.3 caps a reverse-path at 256 octets; 320 leaves room
    -- for the angle brackets and a long address without admitting a body.
    length(envelope_from) <= 320 AND envelope_from !~ '[[:cntrl:]]'
  );

-- Deliberately NOT added to quarantine_removals. That record outlives the
-- message and is content-free by design — a digest, timestamps, hostnames, a
-- size rung. An envelope sender is attacker-written text, and a table that
-- survives the deletion of the thing it describes is the last place it belongs.

-- +goose Down
ALTER TABLE quarantine DROP COLUMN envelope_from;
ALTER TABLE sender_allowlist DROP CONSTRAINT sender_allowlist_no_forwarder_as_outer;
ALTER TABLE sender_allowlist ADD CONSTRAINT sender_allowlist_no_forwarder_as_outer CHECK (
  scope <> 'outer' OR domain NOT IN (
    'gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'mac.com',
    'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com',
    'proton.me', 'protonmail.com', 'zoho.com', 'fastmail.com'
  )
);
