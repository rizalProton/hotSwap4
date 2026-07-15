import { jsonReplacer } from "./persistence.js";

export class StructuredLogger {
  constructor({ sink = console.log } = {}) {
    this.sink = sink;
  }

  log(event, fields = {}) {
    this.sink(
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          event,
          ...fields
        },
        jsonReplacer
      )
    );
  }
}

export class SilentLogger {
  log() {}
}
