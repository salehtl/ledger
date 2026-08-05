/** Content-free layout fingerprint, byte-for-byte compatible with Go diag.StructureSig. */
import { platform } from "../platform";

export const STRUCTURE_SHAPE_BYTES = 4 << 10;

const digit = /^\p{Nd}$/u;
const letterOrNumber = /^(?:\p{L}|\p{N})$/u;
const arabic = /^\p{Script=Arabic}$/u;
const markOrFormat = /^(?:\p{M}|\p{Cf})$/u;
const control = /^\p{Cc}$/u;
const whitespace = /^\p{White_Space}$/u;
const numberSeparator = new Set([",", ".", "'", "٫", "٬"]);

type ClassSymbol = "A" | "B" | "C";

function letterClass(ch: string): ClassSymbol | null {
  if (!letterOrNumber.test(ch)) return null;
  if (ch.codePointAt(0)! < 0x80) return "A";
  return arabic.test(ch) ? "B" : "C";
}

function skippable(ch: string): boolean {
  if (ch === "\t" || ch === "\r" || ch === "\n") return false;
  return markOrFormat.test(ch) || control.test(ch);
}

/** Exposed for the content-free invariant test; callers normally want structureSig. */
export function structureShape(input: string): string {
  const chars = [...input];
  let out = "";
  let last = "";
  let pendingSpace = false;
  const writeSpace = () => {
    if (pendingSpace && out.length > 0 && last !== "\n") out += " ";
    pendingSpace = false;
  };
  const emit = (symbol: string) => {
    if (last === symbol) {
      pendingSpace = false;
      return;
    }
    writeSpace();
    out += symbol;
    last = symbol;
  };
  const newline = () => {
    pendingSpace = false;
    out += "\n";
    last = "\n";
  };

  for (let i = 0; i < chars.length;) {
    const ch = chars[i]!;
    if (ch === "\r") {
      i += chars[i + 1] === "\n" ? 2 : 1;
      newline();
    } else if (ch === "\n") {
      i++;
      newline();
    } else if (skippable(ch)) {
      i++;
    } else if (whitespace.test(ch)) {
      pendingSpace = true;
      i++;
    } else if (digit.test(ch)) {
      i++;
      while (i < chars.length && digit.test(chars[i]!)) i++;
      while (i + 1 < chars.length && numberSeparator.has(chars[i]!) && digit.test(chars[i + 1]!)) {
        i++;
        while (i < chars.length && digit.test(chars[i]!)) i++;
      }
      emit("0");
    } else {
      const cls = letterClass(ch);
      if (cls === null) {
        writeSpace();
        out += ch;
        last = ch;
        i++;
      } else {
        i++;
        while (i < chars.length) {
          const next = chars[i]!;
          if (skippable(next)) {
            i++;
            continue;
          }
          if (letterClass(next) !== cls) break;
          i++;
        }
        emit(cls);
      }
    }
  }

  const shaped = out.trim();
  const p = platform();
  const bytes = p.utf8Encode(shaped);
  if (bytes.byteLength <= STRUCTURE_SHAPE_BYTES) return shaped;
  // TextDecoder replacement semantics would hide a split rune. Back off over
  // UTF-8 continuation bytes before decoding, exactly as Go backs off to the
  // last complete rune.
  let end = STRUCTURE_SHAPE_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return p.utf8Decode(bytes.slice(0, end));
}

export function structureSig(normalized: string): string {
  const p = platform();
  return p.toHex(p.sha256(p.utf8Encode(structureShape(normalized)))).slice(0, 32);
}
