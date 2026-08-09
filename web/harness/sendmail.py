# Posts one corpus message to the scratch SMTP listener, verbatim.
#
# The bytes are sent UNCHANGED — a DKIM signature covers the headers and the
# body, so anything that rewrites either (a rebuilt To:, a re-wrapped body)
# turns a verifying message into an unauthenticated one, which is the state the
# whole walk is stuck behind. The envelope recipient is the only thing that
# routes it, and the envelope is not signed.
#
# The listener port follows `v2stack.sh`'s, which is overridable so two stacks
# can run at once; `LEDGER_V2_SMTP_PORT` is the same variable that script reads.
#
#   python3 harness/sendmail.py <inbound-address> <path-to.eml>
import os, smtplib, sys

addr, path = sys.argv[1], sys.argv[2]
s = smtplib.SMTP("127.0.0.1", int(os.environ.get("LEDGER_V2_SMTP_PORT", "2526")))
s.sendmail("someone@gmail.com", [addr], open(path, "rb").read())
s.quit()
print(f"  ok  posted {path.split('/')[-1]} to {addr}")
