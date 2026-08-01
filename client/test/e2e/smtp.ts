/**
 * A minimal SMTP sender, for delivering real corpus mail to a real `ledgerd`.
 *
 * # Why this is hand-written rather than a library
 *
 * The messages this delivers are signed. Anything that "helps" — re-wrapping a
 * long header, re-encoding a body, normalising a charset, adding its own
 * `Message-ID` or `Date` — invalidates the DKIM signature the whole trusted
 * lane depends on, and the symptom is a `dkim=fail` that reads like a bug in
 * the verifier. What is wanted here is a dumb pipe: the bytes on the socket are
 * the bytes of the `.eml`, transformed only by the two things RFC 5321
 * REQUIRES (CRLF line endings and dot-stuffing) and by nothing else.
 *
 * # Dot-stuffing is the trap, and the corpus contains the trap
 *
 * A line beginning with `.` must be sent with an extra leading `.`, which the
 * receiver strips. Skip it and the receiver reads a line consisting of a single
 * `.` as END-OF-DATA: the message is silently TRUNCATED there, accepted with a
 * 250, and then fails DKIM because the body hash covers bytes that never
 * arrived. Two of the seven committed fixtures have such lines
 * (`enbd-proofpoint-p.eml` has three, `enbd-selector1.eml` one), so this is not
 * a hypothetical — it is the first thing an exit test would trip over, and it
 * would look like a crypto failure rather than a transport one.
 */

/** Where in the conversation a reply came from. */
export type SMTPStage = "GREETING" | "EHLO" | "MAIL" | "RCPT" | "DATA" | "BODY" | "QUIT";

export interface SMTPReply {
  /** The three-digit code. */
  code: number;
  /** The reply text, continuation lines joined with `\n`. */
  message: string;
  /** The command this answered. */
  stage: SMTPStage;
}

export interface SendOptions {
  host: string;
  port: number;
  /** The envelope recipient. */
  rcpt: string;
  /** The message, as it should arrive. */
  raw: Uint8Array;
  /**
   * The envelope sender. Defaults to the message's own `Return-Path`, which is
   * what the original receiving MTA recorded the envelope sender as.
   *
   * Not cosmetic: `origin.ResolveWithEnvelope` only accepts a DKIM signature as
   * the OUTER origin when its `d=` ALIGNS with the envelope domain, so a made-up
   * sender turns a verifiable bank message into `unverified:example.invalid`
   * and the trusted lane becomes unreachable for reasons having nothing to do
   * with the signature.
   */
  from?: string;
  /** The EHLO name. Never resolved by anything; it just has to be syntax. */
  ehlo?: string;
  /** Per-reply deadline. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

const CR = 0x0d;
const LF = 0x0a;
const DOT = 0x2e;

/**
 * Converts to canonical CRLF line endings.
 *
 * SMTP's line terminator is CRLF and nothing else, so this is required rather
 * than tidy — but it is also the SAFE direction for a signed message: DKIM's
 * body hash is defined over CRLF-terminated lines, so a file stored with bare
 * LFs verifies only once it is put back on the wire this way. The committed
 * corpus is already CRLF throughout; this exists so a fixture that is not
 * cannot fail as a signature error.
 */
export function toCRLF(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length * 2);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!;
    if (b === CR) {
      out[n++] = CR;
      out[n++] = LF;
      if (raw[i + 1] === LF) i++; // an existing CRLF, consumed whole
    } else if (b === LF) {
      out[n++] = CR;
      out[n++] = LF;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

/**
 * The DATA payload: CRLF-normalised, dot-stuffed, CRLF-terminated.
 *
 * Exported so it can be asserted on directly. The end-to-end proof that it is
 * right is elsewhere and stronger — the sha256 the server records for a
 * delivered message equals the sha256 of the file on disk — but a unit-visible
 * function makes a failure readable instead of arriving as "DKIM broke".
 */
export function dotStuff(raw: Uint8Array): Uint8Array {
  const crlf = toCRLF(raw);
  // Worst case: every byte is a lone `.` on its own line.
  const out = new Uint8Array(crlf.length * 2 + 2);
  let n = 0;
  let atLineStart = true;
  for (let i = 0; i < crlf.length; i++) {
    const b = crlf[i]!;
    if (atLineStart && b === DOT) out[n++] = DOT;
    out[n++] = b;
    atLineStart = b === LF;
  }
  // The terminator is `CRLF.CRLF`, so the body must end on a line boundary. A
  // message whose last line has no CRLF would otherwise have the terminator
  // welded onto it, changing that line's content.
  if (n === 0 || out[n - 1] !== LF) {
    out[n++] = CR;
    out[n++] = LF;
  }
  return out.subarray(0, n);
}

/**
 * Bytes to a string, one char per byte.
 *
 * Hand-rolled rather than `new TextDecoder("latin1")` for two reasons, and both
 * matter here: WHATWG maps the `latin1` LABEL to windows-1252, which rewrites
 * 0x80–0x9F into other code points; and a UTF-8 decoder turns a multi-byte
 * sequence split across two socket chunks into a replacement character. This
 * round-trips every byte, which is what a protocol parser needs.
 */
function bytesToString(b: Uint8Array): string {
  let out = "";
  // Chunked: String.fromCharCode(...b) blows the argument limit on a real
  // message and fails as "Maximum call stack size exceeded".
  for (let i = 0; i < b.length; i += 4096) {
    out += String.fromCharCode(...b.subarray(i, i + 4096));
  }
  return out;
}

/** The `Return-Path` of a message, without the angle brackets, or "". */
export function returnPath(raw: Uint8Array): string {
  // Header block only: a body line that happens to start with `Return-Path:`
  // is body text, and reading it would let message CONTENT choose the envelope.
  const text = bytesToString(raw);
  const end = text.search(/\r?\n\r?\n/);
  const headers = end < 0 ? text : text.slice(0, end);
  const m = /^Return-path\s*:\s*(.*)$/im.exec(headers);
  if (m?.[1] === undefined) return "";
  return m[1].trim().replace(/^</, "").replace(/>$/, "").trim();
}

/**
 * Runs one SMTP transaction and returns the reply that decided it.
 *
 * The returned reply is the FIRST non-2xx/3xx one, or the DATA acceptance when
 * every step succeeded — so a caller reads one code and one stage rather than a
 * transcript. `QUIT` is always attempted, including after a rejection, because
 * a receiver that tarpits invalid recipients (this one does) counts abandoned
 * connections differently from completed ones.
 */
export async function smtpSend(o: SendOptions): Promise<SMTPReply> {
  const timeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const from = o.from ?? returnPath(o.raw);
  const wire = await connect(o.host, o.port, timeout);
  try {
    const greeting = await wire.reply("GREETING");
    if (!ok(greeting)) return greeting;

    const ehlo = await wire.send(`EHLO ${o.ehlo ?? "harness.invalid"}`, "EHLO");
    if (!ok(ehlo)) return ehlo;

    // No SIZE parameter: smtpd switches go-smtp's own size logic OFF and owns
    // every size refusal itself, so declaring one here would exercise a
    // different rejection path than a real oversized message takes.
    const mail = await wire.send(`MAIL FROM:<${from}>`, "MAIL");
    if (!ok(mail)) return mail;

    const rcpt = await wire.send(`RCPT TO:<${o.rcpt}>`, "RCPT");
    if (!ok(rcpt)) return rcpt;

    const data = await wire.send("DATA", "DATA");
    if (!ok(data)) return data;

    wire.writeBytes(dotStuff(o.raw));
    wire.writeBytes(new Uint8Array([DOT, CR, LF]));
    return await wire.reply("BODY");
  } finally {
    try {
      await wire.send("QUIT", "QUIT");
    } catch {
      /* the receiver may have hung up already; the transaction is over */
    }
    wire.close();
  }
}

// ---------------------------------------------------------------------------
// the socket
// ---------------------------------------------------------------------------

function ok(r: SMTPReply): boolean {
  return r.code >= 200 && r.code < 400;
}

interface Wire {
  send(line: string, stage: SMTPStage): Promise<SMTPReply>;
  reply(stage: SMTPStage): Promise<SMTPReply>;
  writeBytes(b: Uint8Array): void;
  close(): void;
}

async function connect(host: string, port: number, timeoutMs: number): Promise<Wire> {
  let buffered = "";
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;

  const bump = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };

  const socket = await Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_s, chunk: Uint8Array): void {
        // One char per byte, so a chunk boundary can never land inside
        // anything: replies are ASCII, and a byte-faithful buffer keeps the
        // CRLF scan below exact regardless.
        buffered += bytesToString(chunk);
        bump();
      },
      close(): void {
        ended = true;
        bump();
      },
      end(): void {
        ended = true;
        bump();
      },
      error(_s, err: Error): void {
        failure = err;
        ended = true;
        bump();
      },
      connectError(_s, err: Error): void {
        failure = err;
        ended = true;
        bump();
      },
    },
  });

  async function reply(stage: SMTPStage): Promise<SMTPReply> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const taken = takeReply(buffered);
      if (taken !== null) {
        buffered = taken.rest;
        return { ...taken.reply, stage };
      }
      if (failure !== undefined) throw new Error(`smtp ${stage}: ${failure.message}`);
      if (ended) throw new Error(`smtp ${stage}: connection closed with ${JSON.stringify(buffered)} buffered`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`smtp ${stage}: timed out after ${timeoutMs}ms`);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, Math.min(left, 50));
      });
    }
  }

  return {
    reply,
    async send(line: string, stage: SMTPStage): Promise<SMTPReply> {
      socket.write(`${line}\r\n`);
      return await reply(stage);
    },
    writeBytes(b: Uint8Array): void {
      socket.write(b);
    },
    close(): void {
      socket.end();
    },
  };
}

/**
 * Pulls one complete reply out of the buffer, or null if more is needed.
 *
 * Multi-line replies (`250-PIPELINING` then `250 SIZE`) are one reply, not
 * several: reading them as several puts every later command one reply out of
 * step, which presents as the DATA acceptance being attributed to RCPT.
 */
function takeReply(buf: string): { reply: { code: number; message: string }; rest: string } | null {
  const lines: string[] = [];
  let i = 0;
  for (;;) {
    const nl = buf.indexOf("\r\n", i);
    if (nl < 0) return null;
    const line = buf.slice(i, nl);
    i = nl + 2;
    if (!/^\d{3}/.test(line)) {
      throw new Error(`smtp: malformed reply line ${JSON.stringify(line)}`);
    }
    lines.push(line.slice(4));
    if (line.length === 3 || line[3] === " ") {
      return { reply: { code: Number(line.slice(0, 3)), message: lines.join("\n") }, rest: buf.slice(i) };
    }
    if (line[3] !== "-") {
      throw new Error(`smtp: reply line ${JSON.stringify(line)} separates code and text with neither " " nor "-"`);
    }
  }
}
