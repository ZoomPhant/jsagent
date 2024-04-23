module.exports = import('lighthouse').then(async ({Audit}) => {
    /** @typedef {{ignoredPatterns?: Array<RegExp|string>}} AuditOptions */
    class ErrorLogs extends Audit {
        /**
         * @return {LH.Audit.Meta}
         */
        static get meta() {
            return {
                id: 'zp-console-log',
                title: 'Console output',
                failureTitle: 'Console has exceptional output',
                description: 'Collect console outputs',
                requiredArtifacts: ['ConsoleLog', 'SourceMaps', 'Scripts'],
            };
        }

        /**
         * @param {LH.Artifacts} artifacts
         * @param {LH.Audit.Context} context
         * @return {Promise<LH.Audit.Product>}
         */
        static async audit(artifacts, context) {
            const data = artifacts.ConsoleLog;

            const entries = data.entries || []

            let error = 0;
            let warn = 0;
            let info = 0;

            for(const entry in entries) {
                if(entry.level === 'error') {
                    error ++;
                }
                else if(entry.level === 'warn') {
                    info ++;
                }
                else {
                    info ++;
                }
            }

            /** @type {Array<{source: string, description: string|undefined, sourceLocation: LH.Audit.Details.SourceLocationValue|undefined}>} */
            return {
                score: (error > 0 || warn > 0) ? 0 : 1,
                details: {error, warn, info, ...data,}
            };
        }
    }

    return ErrorLogs
})
