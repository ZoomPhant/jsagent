module.exports = import("lighthouse").then(async ({ Gatherer }) => {
  return class BrowserNavigationGatherer extends Gatherer {
    meta = {
      supportedModes: ["navigation", "timespan", "snapshot"],
    };
    async getArtifact(context) {
      const performanceEntries = await context.driver.executionContext
        .evaluateAsync(`
      (function() {
        const entry = performance.getEntriesByType('navigation')[0];
        return {
          dnsTime: entry.domainLookupEnd - entry.domainLookupStart,
          connectTime: entry.connectEnd - entry.connectStart,
          handshakeTime: entry.secureConnectionStart ? (entry.connectEnd - entry.secureConnectionStart) : 0,
          ttfbTime: entry.responseStart - entry.requestStart
        };
      })()
    `);
      return performanceEntries;
    }
  };
});
