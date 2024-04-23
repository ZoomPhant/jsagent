module.exports = import('lighthouse').then(async ({Audit}) => {
    class SecurityLogs extends Audit {
        static get meta() {
            return {
                id: 'zp-security-log',
                title: 'Security logs',
                failureTitle: 'Security logs with errors',
                description: 'Collect security stuff',
                requiredArtifacts: ['SecurityLog'],
            };
        }

        /**
         * @param {LH.Artifacts} artifacts
         * @param {LH.Audit.Context} context
         * @return {Promise<LH.Audit.Product>}
         */
        static async audit(artifacts, context) {
            const data = artifacts.SecurityLog;

            return {
                score: 0,
                details: data,
            };
        }
    }

    return SecurityLogs
})
