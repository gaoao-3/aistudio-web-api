import { densifySparseJSON } from "./sparse-json.js";

const XSSI_PREFIX = ")]}'";

/** Extracts the depth-3 response chunks from AI Studio's streamed JSON envelope. */
export class IncrementalAIStudioParser {
  private buffer = "";
  private depth = 0;
  private inString = false;
  private escape = false;
  private chunkStart: number | undefined;
  private preambleSkipped = false;
  private position = 0;

  feed(data: string): unknown[][] {
    this.buffer += data;
    const chunks: unknown[][] = [];

    while (true) {
      if (!this.preambleSkipped) {
        if (this.buffer.startsWith(XSSI_PREFIX)) {
          this.buffer = this.buffer.slice(XSSI_PREFIX.length).trimStart();
        } else if (XSSI_PREFIX.startsWith(this.buffer)) {
          break;
        }
        this.preambleSkipped = true;
      }

      let madeProgress = false;
      while (this.position < this.buffer.length) {
        const char = this.buffer[this.position]!;
        if (this.escape) {
          this.escape = false;
          this.position += 1;
          continue;
        }
        if (char === "\\" && this.inString) {
          this.escape = true;
          this.position += 1;
          continue;
        }
        if (char === '"') {
          this.inString = !this.inString;
          this.position += 1;
          continue;
        }
        if (this.inString) {
          this.position += 1;
          continue;
        }
        if (char === "[") {
          this.depth += 1;
          if (this.depth === 3 && this.chunkStart === undefined) this.chunkStart = this.position;
        } else if (char === "]") {
          this.depth -= 1;
          if (this.depth === 2 && this.chunkStart !== undefined) {
            const raw = this.buffer.slice(this.chunkStart, this.position + 1);
            try {
              const parsed: unknown = JSON.parse(densifySparseJSON(raw));
              if (Array.isArray(parsed)) chunks.push(parsed);
            } catch {
              // A malformed upstream chunk is ignored just like the legacy parser.
            }
            this.buffer = this.buffer.slice(this.position + 1);
            this.position = 0;
            this.chunkStart = undefined;
            madeProgress = true;
            continue;
          }
        }
        this.position += 1;
      }
      if (!madeProgress) break;
    }
    return chunks;
  }
}
