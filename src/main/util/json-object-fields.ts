import type { FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const CHUNK_BYTES = 256 * 1024;
export const INVALID_JSON_RECORD = Symbol('invalid JSON record');

const enum Expect {
  Root, End, ObjectStart, Key, Colon, ObjectValue, ObjectEnd, ArrayStart, ArrayValue, ArrayEnd,
}

const enum Token {
  String = -1, Atom = -2,
  ObjectStart = 0x7b, ObjectEnd = 0x7d, ArrayStart = 0x5b, ArrayEnd = 0x5d, Colon = 0x3a, Comma = 0x2c,
}

// Consume ordinary string runs in native code, including across input chunks.
const stringRun = /[^"\\\x00-\x1f]+/y;
const digitRun = /[0-9]+/y;
const hex = /^[0-9a-fA-F]$/;
const numberStart = /^[-0-9]$/;
const trimSpace = /^\s$/;

const enum NumberPart { Start, IntegerStart, Zero, Integer, FractionStart, Fraction, ExponentSign, ExponentStart, Exponent }

type Capture = {
  kind: 'key' | 'field' | 'root';
  parts: string[];
  start: number;
  length: number;
};

/** Validate the entire row but materialize only selected top-level fields.
 * This keeps large unselected strings and arrays out of the JS heap. */
class JsonFieldReader {
  private readonly stack = [Expect.Root];
  private readonly result: Record<string, unknown> = Object.create(null);
  private readonly longestKey: number;
  private field = '';
  private capture?: Capture;
  private rootValue: unknown = this.result;
  private stringOpen = false;
  private escaped = false;
  private unicodeDigits = 0;
  private literal = '';
  private literalOffset = 0;
  private number?: NumberPart;

  constructor(private readonly fields: ReadonlySet<string>) {
    // A key may encode each UTF-16 code unit as a six-character escape.
    this.longestKey = Math.max(0, ...Array.from(fields, field => field.length * 6 + 2));
  }

  private get expect(): Expect { return this.stack[this.stack.length - 1]; }
  private set expect(next: Expect) { this.stack[this.stack.length - 1] = next; }

  private value(token: Token, next: Expect): boolean {
    this.expect = next;
    if (token === Token.ObjectStart) this.stack.push(Expect.ObjectStart);
    else if (token === Token.ArrayStart) this.stack.push(Expect.ArrayStart);
    else if (token !== Token.String && token !== Token.Atom) return false;
    return true;
  }

  private accept(token: Token): boolean {
    switch (this.expect) {
      case Expect.Root: return this.value(token, Expect.End);
      case Expect.ObjectStart:
        if (token === Token.ObjectEnd) { this.stack.pop(); return true; }
        // The first key otherwise follows the same grammar as later keys.
        // falls through
      case Expect.Key:
        if (token !== Token.String) return false;
        this.expect = Expect.Colon;
        return true;
      case Expect.Colon:
        if (token !== Token.Colon) return false;
        this.expect = Expect.ObjectValue;
        return true;
      case Expect.ObjectValue: return this.value(token, Expect.ObjectEnd);
      case Expect.ObjectEnd:
        if (token === Token.ObjectEnd) { this.stack.pop(); return true; }
        if (token !== Token.Comma) return false;
        this.expect = Expect.Key;
        return true;
      case Expect.ArrayStart:
        if (token === Token.ArrayEnd) { this.stack.pop(); return true; }
        return this.value(token, Expect.ArrayEnd);
      case Expect.ArrayValue: return this.value(token, Expect.ArrayEnd);
      case Expect.ArrayEnd:
        if (token === Token.ArrayEnd) { this.stack.pop(); return true; }
        if (token !== Token.Comma) return false;
        this.expect = Expect.ArrayValue;
        return true;
      case Expect.End: return false;
    }
  }

  private beginCapture(chunk: string, start: number): void {
    const { expect } = this;
    let kind: Capture['kind'];
    if (this.stack.length === 2 && (expect === Expect.Key || expect === Expect.ObjectStart) && chunk[start] === '"') {
      this.field = '';
      kind = 'key';
    } else if (this.stack.length === 2 && expect === Expect.ObjectValue && this.fields.has(this.field)) {
      kind = 'field';
    } else if (expect === Expect.Root && chunk[start] !== '{' && chunk[start] !== '[') {
      // Preserve the legacy reader's treatment of valid non-object JSON rows.
      kind = 'root';
    } else return;
    this.capture = { kind, parts: [], start, length: 0 };
  }

  private storeCapture(chunk: string, end: number): void {
    const capture = this.capture;
    if (!capture) return;
    capture.length += end - capture.start;
    if (capture.kind === 'key' && capture.length > this.longestKey) {
      this.capture = undefined;
      return;
    }
    if (end > capture.start) capture.parts.push(chunk.slice(capture.start, end));
    capture.start = 0;
  }

  private finishToken(token: Token, chunk: string, end: number): boolean {
    if (!this.accept(token)) return false;
    const { capture, expect } = this;
    if (!capture) return true;
    const done = capture.kind === 'root' ? expect === Expect.End && this.stack.length === 1
      : this.stack.length === 2 && expect === (capture.kind === 'key' ? Expect.Colon : Expect.ObjectEnd);
    if (!done) return true;
    this.storeCapture(chunk, end);
    if (!this.capture) return true;
    this.capture = undefined;
    let value: unknown;
    try { value = JSON.parse(capture.parts.join('')); }
    catch (err) { if (err instanceof SyntaxError) return false; throw err; }
    if (capture.kind === 'key') this.field = value as string;
    else if (capture.kind === 'field') this.result[this.field] = value;
    else this.rootValue = value;
    return true;
  }

  private consumeString(chunk: string, start: number): number {
    let pos = start;
    while (pos < chunk.length) {
      if (this.unicodeDigits) {
        if (!hex.test(chunk[pos++])) return -1;
        this.unicodeDigits--;
        continue;
      }
      if (this.escaped) {
        this.escaped = false;
        const code = chunk[pos++];
        if (code === 'u') this.unicodeDigits = 4;
        else if (!'"\\/bfnrt'.includes(code)) return -1;
        continue;
      }
      stringRun.lastIndex = pos;
      if (stringRun.test(chunk)) pos = stringRun.lastIndex;
      if (pos === chunk.length) break;
      const code = chunk[pos++];
      if (code === '\\') this.escaped = true;
      else if (code === '"') { this.stringOpen = false; break; }
      else return -1;
    }
    return pos;
  }

  private consumeNumber(chunk: string, start: number): number {
    let pos = start;
    while (pos < chunk.length) {
      const code = chunk[pos];
      const digit = code >= '0' && code <= '9';
      switch (this.number) {
        case NumberPart.Start:
          this.number = NumberPart.IntegerStart;
          if (code === '-') { pos++; continue; }
          continue;
        case NumberPart.IntegerStart:
          if (!digit) return -1;
          this.number = code === '0' ? NumberPart.Zero : NumberPart.Integer;
          pos++;
          continue;
        case NumberPart.ExponentSign:
          this.number = NumberPart.ExponentStart;
          if (code === '+' || code === '-') { pos++; continue; }
          continue;
        case NumberPart.FractionStart:
        case NumberPart.ExponentStart:
          if (!digit) return -1;
          this.number = this.number === NumberPart.FractionStart ? NumberPart.Fraction : NumberPart.Exponent;
          break;
      }
      if (digit && this.number !== NumberPart.Zero) {
        digitRun.lastIndex = pos;
        digitRun.test(chunk);
        pos = digitRun.lastIndex;
        continue;
      }
      if (code === '.' && (this.number === NumberPart.Zero || this.number === NumberPart.Integer)) {
        this.number = NumberPart.FractionStart;
      } else if ((code === 'e' || code === 'E') && this.number !== NumberPart.Exponent) {
        this.number = NumberPart.ExponentSign;
      } else {
        this.number = undefined;
        return this.finishToken(Token.Atom, chunk, pos) ? pos : -1;
      }
      pos++;
    }
    return pos;
  }

  write(chunk: string): boolean {
    let pos = 0;
    while (pos < chunk.length) {
      if (this.stringOpen) {
        pos = this.consumeString(chunk, pos);
        if (pos < 0 || (!this.stringOpen && !this.finishToken(Token.String, chunk, pos))) return false;
        continue;
      }
      if (this.number !== undefined) {
        pos = this.consumeNumber(chunk, pos);
        if (pos < 0) return false;
        continue;
      }
      if (this.literal) {
        if (chunk[pos++] !== this.literal[this.literalOffset++]) return false;
        if (this.literalOffset === this.literal.length) {
          this.literal = '';
          if (!this.finishToken(Token.Atom, chunk, pos)) return false;
        }
        continue;
      }

      const byte = chunk.charCodeAt(pos);
      if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a
        || (this.stack.length === 1 && trimSpace.test(chunk[pos]))) { pos++; continue; }
      if (!this.capture && this.stack.length <= 2) this.beginCapture(chunk, pos);
      if (byte === 0x22) this.stringOpen = true;
      else if (byte === 0x74 || byte === 0x66 || byte === 0x6e) {
        this.literal = byte === 0x74 ? 'true' : byte === 0x66 ? 'false' : 'null';
        this.literalOffset = 1;
      } else if (numberStart.test(chunk[pos])) {
        this.number = NumberPart.Start;
        continue;
      } else if (!this.finishToken(byte as Token, chunk, pos + 1)) return false;
      pos++;
    }
    this.storeCapture(chunk, chunk.length);
    return true;
  }

  finish(): unknown {
    if (this.number === NumberPart.Zero || this.number === NumberPart.Integer
      || this.number === NumberPart.Fraction || this.number === NumberPart.Exponent) {
      if (!this.finishToken(Token.Atom, '', 0)) return INVALID_JSON_RECORD;
      this.number = undefined;
    }
    if (this.stack.length !== 1 || this.stringOpen || this.literal || this.number !== undefined) {
      return INVALID_JSON_RECORD;
    }
    return this.expect === Expect.End ? this.rootValue : undefined;
  }
}

/** Read one known line range without retaining or decoding it as one string. */
export async function readJsonObjectFields(
  handle: FileHandle, start: number, end: number, fields: ReadonlySet<string>, strictIo = false,
): Promise<unknown> {
  const reader = new JsonFieldReader(fields);
  const decoder = new StringDecoder('utf8');
  const block = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - start));
  for (let pos = start; pos < end;) {
    const bytes = Math.min(block.length, end - pos);
    const { bytesRead } = await handle.read(block, 0, bytes, pos);
    if (strictIo && bytesRead !== bytes) throw new Error('JSONL read is incomplete');
    if (bytesRead <= 0 || !reader.write(decoder.write(block.subarray(0, bytesRead)))) return INVALID_JSON_RECORD;
    pos += bytesRead;
  }
  if (!reader.write(decoder.end())) return INVALID_JSON_RECORD;
  return reader.finish();
}
