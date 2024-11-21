module.exports = import("lighthouse").then(async ({ Audit }) => {
  return class BrowserNavigationAudit extends Audit {
    static get meta() {
      return {
        id: "browser-navigation-metrics",
        failureTitle: "Slow page load",
        title: "Browser Navigation Metrics",
        description: "Detailed browser Navigation Metrics",
        requiredArtifacts: ["BrowserNavigationGatherer"],
      };
    }
    static audit(artifacts) {
      return {
        score: 1,
        numericValue: 0,
        numericUnit: "millisecond",
        details: {
          type: "browser-navigation-timing",
          headings: [
            {
              key: "metric",
              itemType: "text",
              text: "Metric",
            },
            {
              key: "value",
              itemType: "ms",
              text: "Time (ms)",
            },
          ],
          items: Object.entries(artifacts?.BrowserNavigationGatherer || {}).map(
            ([key, value]) => ({
              key,
              value,
            })
          ),
        },
      };
    }
  };
});
