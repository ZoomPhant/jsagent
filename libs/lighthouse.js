/**
 * According to the link below, it is suggested that no paralleling in same process for lighthouse
 * process: https://github.com/GoogleChrome/lighthouse/issues/7187
 *
 * So for simplicity, we would just wait the lighthouse for a few while and then fail if it not
 * released by caller
 */

const logger = require('libs/logger').get('chrome');
const util = require('util');
const request = require('request');
const LH = import('lighthouse');

/**
 * Helper to
 * @param prom
 * @param time
 * @returns {Promise<*|Promise<unknown> extends PromiseLike<infer U> ? U : (*|Promise<unknown>)>}
 */
const timeout = (prom, time) => Promise.race([prom, new Promise((_r, rej) => setTimeout(rej, time))]);

const state = {
    url: '',
    promise: null
}

/**
 * Note: we add a waitTimeout flag in flags, so caller can decide how long to wait for lighthouse
 */
const lightHouseWrapper = async (url, flags = {}, configJSON, userConnection) => {
    if(state.promise) {
        // let's hard code to 15 seconds for now
        logger.info('Found on-going lighthouse session for ' + state.url)
        try {
            await timeout(state.promise, flags?.waitTimeout || 15000)
            logger.info('Previous lighthouse session finished, continuing ...')
        }
        catch(err) {
            logger.error('Waiting previous lighthouse session failed - ' + state.url);
            throw new Error('On-going lighthouse session found for ' + state.url)
        }
    }

    // record the on-going session
    logger.info('Queuing lighthouse session for url - ' + url)

    const promise = LH.then(async ({default : lighthouse}) => {
        const config = {
            // 1. Run your custom tests along with all the defau
            // lt Lighthouse tests.
            extends: 'lighthouse:default',

            // 2. Register new artifact with custom gatherer.
            artifacts: [
                {id: 'ConsoleLog', gatherer: 'plugins/lighthouse/console-gatherer'},
                {id: 'SecurityLog', gatherer: 'plugins/lighthouse/security-gatherer'},
            ],

            // 3. Add custom audit to the list of audits 'lighthouse:default' will run.
            audits: [
                'plugins/lighthouse/console-audit',
                'plugins/lighthouse/security-audit',
            ],

            // 4. Create a new 'My site audits' section in the default report for our results.
            categories: {
                addons: {
                    title: 'Additional audits',
                    description: 'Audits for additional stuff',
                    auditRefs: [
                        // When we add more custom audits, `weight` controls how they're averaged together.
                        {id: 'zp-console-log', weight: 1},
                        {id: 'zp-security-log', weight: 1},
                    ],
                },
            },
             ...configJSON
        };

        logger.info('Running lighthouse session with custom audit on');
        return lighthouse(url, flags, config, userConnection)
    }).finally(async () => {
        // clear the promise ...
        logger.info('Lighthouse session finished for url - ' + url)
        state.url = '';
        state.promise = null;
    })

    state.url = url;
    state.promise = promise;

    return promise;
}

module.exports = lightHouseWrapper;