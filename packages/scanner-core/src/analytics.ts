// analytics.ts
// Records one PII-FREE event per scan and flushes them to the ingest endpoint in
// batches, buffering when offline. NOTHING here may contain document data
// (no name, DOB, number, address) - only counts and metadata. Keeping PII out of
// this pipeline is what keeps it out of PIPEDA scope; do not "enrich" these events.

import type { FieldSource } from "./canonical";

export interface ScanEvent {
  jti: string;                 // license id (from the verified token)
  ts: string;                  // ISO timestamp
  documentType: string;        // "drivers_license" | "id_card" | "passport" | "unknown"
  jurisdiction: string;        // e.g. "CA-QC"
  source: FieldSource;         // "barcode" | "ocr" | "mrz"
  success: boolean;
  confidenceBucket: "high" | "medium" | "low";
  deviceModel: string;         // e.g. "Apple iPhone" | "Samsung SM-G991B" | "web"
}

// Minimal persistence contract. The plugin backs this with @capacitor/preferences
// so the buffer survives app restarts; the core stays platform-agnostic/testable.
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface AnalyticsConfig {
  ingestUrl: string;           // your API Gateway events endpoint
  store: KeyValueStore;
  batchSize?: number;          // flush when the buffer reaches this many events
}

const BUFFER_KEY = "scan_events_buffer_v1";

export class ScanAnalytics {
  private readonly ingestUrl: string;
  private readonly store: KeyValueStore;
  private readonly batchSize: number;

  constructor(cfg: AnalyticsConfig) {
    this.ingestUrl = cfg.ingestUrl;
    this.store = cfg.store;
    this.batchSize = cfg.batchSize ?? 25;
  }

  /** Append an event; flush opportunistically once the buffer is full. */
  async record(event: ScanEvent): Promise<void> {
    const buffer = await this.read();
    buffer.push(event);
    await this.write(buffer);
    if (buffer.length >= this.batchSize) {
      // fire-and-forget: analytics must never break or block a scan
      void this.flush();
    }
  }

  /** Send the buffered events; clear on success, keep them on failure for retry. */
  async flush(): Promise<void> {
    const buffer = await this.read();
    if (buffer.length === 0) return;
    try {
      const res = await fetch(this.ingestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: buffer }),
      });
      if (res.ok) {
        await this.write([]);
      }
      // non-2xx: leave the buffer intact and try again next time
    } catch {
      // offline / network error: keep the buffer for the next flush
    }
  }

  private async read(): Promise<ScanEvent[]> {
    const raw = await this.store.get(BUFFER_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async write(events: ScanEvent[]): Promise<void> {
    await this.store.set(BUFFER_KEY, JSON.stringify(events));
  }
}
