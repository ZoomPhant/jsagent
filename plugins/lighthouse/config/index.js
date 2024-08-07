'use strict';

/** @type {LH.Config.Json} */
const desktop = {
    extends: 'lighthouse:default',
    settings: {
        maxWaitForFcp: 15 * 1000,
        maxWaitForLoad: 35 * 1000,
        formFactor: 'desktop',
        // throttling: constants.throttling.desktopDense4G,
        // screenEmulation: constants.screenEmulationMetrics.desktop,
        // emulatedUserAgent: constants.userAgents.desktop,

        // Skip the h2 audit so it doesn't lie to us. See https://github.com/GoogleChrome/lighthouse/issues/6539
        // skipAudits: ['uses-http2'],

        // our stuff
        output: 'json',
        disableStorageReset: true,
        emulatedFormFactor: 'desktop',
        onlyCategories: ['performance'],
        onlyAudits: ['server-response-time', 'network-requests', 'interactive', 'largest-contentful-paint', 'first-contentful-paint', 'speed-index', 'total-blocking-time'],
        // quiet: true,
    },
};

const mobile = {
    extends: 'lighthouse:default',
    settings: {
        maxWaitForFcp: 15 * 1000,
        maxWaitForLoad: 35 * 1000,
        // lighthouse:default is mobile by default
        // Skip the h2 audit so it doesn't lie to us. See https://github.com/GoogleChrome/lighthouse/issues/6539
        // skipAudits: ['uses-http2'],

        // our stuff
        formFactor: 'mobile',
        throttling: { // same as desktop, but increase RTT from 40ms to 80ms
            rttMs: 80,
            throughputKbps: 10 * 1024,
            cpuSlowdownMultiplier: 1,
            requestLatencyMs: 0, // 0 means unset
            downloadThroughputKbps: 0,
            uploadThroughputKbps: 0,
        },
        // screenEmulation: constants.screenEmulationMetrics.mobile,
        // emulatedUserAgent: constants.userAgents.mobile,

        output: 'json',
        disableStorageReset: true,
        emulatedFormFactor: 'mobile',
        onlyCategories: ['performance'],
        onlyAudits: ['server-response-time', 'network-requests', 'interactive', 'largest-contentful-paint', 'first-contentful-paint', 'speed-index', 'total-blocking-time'],
    }
};

// import * as constants from 'lighthouse/core/config/constants'
// const constants = require('lighthouse/core/config/constants')
const populates = import('lighthouse/core/config/constants.js').then((constants) => {
    desktop.settings.throttling = constants.throttling.desktopDense4G
    desktop.settings.screenEmulation = constants.screenEmulationMetrics.desktop
    desktop.settings.emulatedUserAgent = constants.userAgents.desktop

    // mobile using our dedicated throttling defined above
    mobile.settings.screenEmulation = constants.screenEmulationMetrics.mobile
    mobile.settings.emulatedUserAgent = constants.userAgents.mobile
});

module.exports = {
    desktop: populates.then(() => desktop),
    mobile: populates.then(() => mobile),
}
