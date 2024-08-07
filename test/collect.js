//*************************************/
require('app-module-path').addPath(__dirname + "/..");
const fs = require('fs')

const helper = require('src/format')
const lighthouse = require('libs/lighthouse')
const logger = require('libs/logger').get('scripts')
const ChromeWrapper = require('src/main/chrome');

const EventLevel = require('libs/levels')

const params = {
    website: "mi0",
    landingUrl: "https://www.bing.com/"
}

const resource = {
	attributes:[]
}

const chrome = new ChromeWrapper()

//*************************************/
// below same as collect.js
//*************************************/

const {Curl} = require('node-libcurl');
const config = require('plugins/lighthouse/config')
const formatter = helper.formatter()

//
// create or get an idle chrome instance. Our run context has a "chrome" variable
// which can be used to create a chrome instance by calling chrome.open and close
// the instance by calling chrome.close

const getValidUrl = url => {
    let newUrl = decodeURIComponent(url);
    newUrl = newUrl.trim().replace(/\s/g, "");

    if(/^(:\/\/)/.test(newUrl)){
        return `http${newUrl}`;
    }
    if(!/^https?:\/\//i.test(newUrl)){
        return `http://${newUrl}`;
    }

    return newUrl
}
//
// this is instance of mp 503, with following attributes
//    website: refer to the relevant instance of mp 501, required
//    landingUrl: landing url, required
//    relativeUri: relative uri to landing url to load
const website = params?.website ?? resource?.attributes["website"]
const landingUrl = getValidUrl(params?.landingUrl ?? resource?.attributes["landingUrl"])
const uri = (params?.uri ?? resource?.attributes["uri"]) || "/"   // uri must be relative

if(!website || website === '') {
    throw new Error('Missing reference website MPI');
}

if(!landingUrl || landingUrl === '') {
    throw new Error('Missing landing URL for page loading')
}

// in milliseconds
const maxLoadTime = Number(resource?.attributes["maxLoadingTime"] || 7) * 1000

// all metrics shall starts with ZP.SPM. for special processing
formatter.prefix("ZP.SPM.")

// add website info
formatter.label("_website", website);

// add location info
// TODO: may add location to configuration instead of process env?
const location = process.env.CollectorLocation || 'Default';
formatter.label("_location", location)

formatter.label("uri", uri)

/**
 * LightHouse may return a runtimeError like
 * {
 *     code: 'xxx',
 *     message: 'xxxx'
 * }
 *
 * This function try turn the code to a number.
 */
const getErrorCode = code => {
    if (!code) {
        return 0
    }

    // todo: code might be a string like NO_FCP etc.
    return 1
}

/**
 * Make sure the site is accessible. If it is accessible, this will return a real
 * URL that lighthouse shall run against (to handle case for redirects, etc.)
 *
 * return stats of the curl request so caller can decide what to do
 */
const verify = async (url, settings, timeout) => {
    return new Promise((resolve) => {
        const curl = new Curl();
        curl.setOpt('URL', url);
        curl.setOpt('SSL_VERIFYPEER', 0)
        curl.setOpt('SSL_VERIFYHOST', 0)
        curl.setOpt('SSL_VERIFYSTATUS', 0)
        curl.setOpt('TIMEOUT', timeout)
        curl.setOpt('USERAGENT', settings.emulatedUserAgent)
        // we send a HEAD request instead of a GET
        curl.setOpt('NOBODY', 1);

        curl.on('end', function (statusCode, data, headers) {
            const redirectUrl = this.getInfo('REDIRECT_URL')

            const totalTime = (Number(this.getInfo('TOTAL_TIME')) || 0) * 1000

            const dnsTime = (Number(this.getInfo('NAMELOOKUP_TIME')) || 0) * 1000

            const connectTimeFromStart = (Number(this.getInfo('CONNECT_TIME')) || 0) * 1000
            const connectTime = connectTimeFromStart - dnsTime;

            // might be zero!!
            const handshakeTimeFromStart = (Number(this.getInfo('APPCONNECT_TIME')) || 0) * 1000
            const handshakeTime = (handshakeTimeFromStart > connectTimeFromStart) ? (handshakeTimeFromStart - connectTimeFromStart) : 0;

            // if there's no handshake time, just calculate the delta from connectTime to here
            const ttfbTimeFromStart = (Number(this.getInfo('STARTTRANSFER_TIME')) || 0) * 1000
            const ttfbTime = (handshakeTimeFromStart > 0) ?                                                          // is handshakeTimeFromStart valid?
                ((ttfbTimeFromStart > handshakeTimeFromStart) ? (ttfbTimeFromStart - handshakeTimeFromStart) : 0) :  // yes, delta to handshakeTimeFromsTart
                ((ttfbTimeFromStart > connectTimeFromStart) ? (ttfbTimeFromStart - connectTimeFromStart) : 0);       // no, delta to connectTimeFromStart

            this.close();
            resolve({
                status: 0,  // success
                statusCode,
                redirectUrl,
                stats: {
                    totalTime,
                    dnsTime,
                    connectTime,
                    handshakeTime,
                    ttfbTime,
                }
            })
        });

        //
        // libcurl error codes: https://curl.se/libcurl/c/libcurl-errors.html
        curl.on('error', function (error, errorCode) {
            let status = -1;
            switch (errorCode) {
                case 6: // cannot resolve host
                    status = 1;
                    break;
                case 7: // cannot connect
                case 9: // access denied, port rejection?
                case 28: // timeout
                    status = 2;
                    break;
                case 35: // ssl handshaking?
                case 53: // ssl engine not found
                case 54: // ssl engine set failed
                case 58: // ssl certs problem
                case 59: // ssl algo problem
                case 64:
                case 66:
                case 77:
                case 98: // client side certs required
                    status = 3;
                    break;
                default:
                    status = -1;
            }

            const message = error?.message || error
            this.close()

            logger.error("Got status " + status + " for verifying " + url + " (errorCode=" + errorCode + ", message=" + message + ")");
            resolve({
                status, message
            })
        })

        curl.perform();
    })
}

/**
 * Collect metrics we want
 */
const collect = async (url, baseWebsite, platform) => {
    const isMobile = platform === 'mobile';
    const options = await Promise.resolve((platform === 'mobile' ? config.mobile : config.desktop))

    const statusEvent = helper.event('spm-webservice-page-load-status', true)
        .catalogs('UserExperience/Function').level(EventLevel.Cleared).data('OK')
        .label('platform', platform);

    // > 2 * maxLoadtime, error, > maxLoadtime seconds, warn
    const statusResponseTime = helper.event('spm-webservice-page-load-slow', true)
        .catalogs('UserExperience/Response').level(EventLevel.Cleared).data('OK')
        .label('platform', platform);

    const startTime = Date.now()
    try {
        const info = await verify(url, options.settings, (params.timeout || 5));

        // by default the event is OK
        formatter.addEvent(statusEvent.get())
        formatter.addEvent(statusResponseTime.get())
        formatter.addMetric(helper.metric("CheckStatus", EventLevel.Info.ordinal()).label("platform", platform).get())

        if (info.status) {
            logger.error('Error verify %s website %s, status=%d', platform, url, info.status)
            formatter.addMetric(helper.metric("status", info.status).label("platform", platform).get())

            formatter.updateEvent(statusEvent.state(-1).level(EventLevel.Error).data((isMobile ? 'Mobile cannot' : 'Cannot') + ' load page').get())
            formatter.updateMetric("CheckStatus", EventLevel.Error.ordinal())
            return
        }

        // status is OK, let's move on
        formatter.addMetric(helper.metric("status", 0).label("platform", platform).get())
        formatter.addMetric(helper.metric("httpCode", info.statusCode).label("platform", platform).get())
        formatter.addMetric(helper.metric("dnsTime", info.stats.dnsTime).label("platform", platform).get())
        formatter.addMetric(helper.metric("tcpTime", info.stats.connectTime).label("platform", platform).get())
        formatter.addMetric(helper.metric("sslDoneTime", info.stats.handshakeTime).label("platform", platform).get())
        // note: should be ttfb, but for some reason, Andy name it as tffb, so just to follow
        formatter.addMetric(helper.metric("tffbTime", info.stats.ttfbTime).label("platform", platform).get())

        if(info.statusCode >= 400) {
            // we won't continue to do lighthouse stuff, but report error here
            /**
             *     httpCodeMsg = String.format("%d", httpCode)
             *     if (httpCode == 0) {
             *         httpCodeMsg = "未知"
             *     }
             *     report.addEvent(EventLevel.ERROR, String.format("页面加载异常，状态码%s", httpCodeMsg), label)
             *     report.addData("ZP.SPM.SLA", value > 0 ? 1 : 0, label)
             *
             *     value = 1
             *     report.addData("ZP.SPM.CheckStatus", value, label)
             *     println(report)
             */

            // we don't report such event as page access check would do this??
            // formatter.updateEvent(statusEvent.state(1).level('error').data((isMobile ? 'Mobile page' : 'Page') + ' returns 4xx or 5xx status code').get())

            logger.warn('Invalid status code %d to run lighthouse against %s website %s', info.statusCode, platform, url)
            return;
        }

        logger.info('Got status code %d and run lighthouse against %s website %s (redirect: %s)', info.statusCode, platform, url, info.redirectUrl || '')
        await chrome.open()
        const flags = {
            port: chrome.getOptions().port
        };

        const start = Date.now()
        const {lhr} = await lighthouse(info.redirectUrl || url, flags, options);

        //*************************************/
        const jsonString = JSON.stringify(lhr, null, 2);
        fs.writeFile(platform + '.json', jsonString, (err) => {
            if (err) {
                console.error('Error writing file:', err);
            } else {
                console.log('File written successfully');
            }
        });
        //*************************************/

        const elapse = Date.now() - start

        // TODO: report lhr.runtimeError.message
        // TODO: report lhr.runWarnings (array of strings)
        if (lhr.runtimeError?.code) {
            logger.error('Error running lighthouse for url ' + url + ' - ' + lhr.runtimeError.code + ": " + lhr.runtimeError.message)
            formatter.updateEvent(statusEvent.state(1).level(EventLevel.Error).data((isMobile ? 'Mobile failed' : 'Failed') + ' to load page due to error code ' + lhr.runtimeError?.code).get())
            formatter.updateMetric("CheckStatus", EventLevel.Error.ordinal())
            return
        }

        const networkRequests = {}

        let requestCount = 0
        let cacheRequest = 0
        let badRequest = 0
        let transferTotalSize = 0
        let resourceTotalSize = 0
        const items = lhr.audits["network-requests"]?.details?.items || []
        for (const item of items) {
            requestCount++;
            transferTotalSize += (item.transferSize || 0)
            resourceTotalSize += (item.resourceSize || 0)

            if (!item.resourceType) {
                // the resource might
                continue
            }

            const type = networkRequests[item.resourceType] || {
                requestCount: 0,
                cacheRequest: 0,
                badRequest: 0,
                totalTransferSize: 0,
                totalResourceSize: 0,
            }

            if (item.statusCode == 304) {
                type.cacheRequest++;
                cacheRequest++;
            }
            else if (item.statusCode >= 300) {
                logger.warn('Bad request %s for url %s', item.statusCode, item.url)
                type.badRequest++;
                badRequest++;
            }

            type.requestCount++;
            type.totalTransferSize += (item.transferSize || 0)
            type.totalResourceSize += (item.resourceSize || 0)

            networkRequests[item.resourceType] = type;
        }

        let loadTime = lhr.audits["interactive"]?.numericValue || 0.0;
        if(loadTime <= 0) {
            logger.error('Missing load time for lighthouse result on %s website %s. Using elsapsed time', platform, url)
            loadTime = elapse
        }

        formatter.addMetric(helper.metric("requestCount", requestCount).label("platform", platform).get())
        formatter.addMetric(helper.metric("CacheRequest", cacheRequest).label("platform", platform).get())
        formatter.addMetric(helper.metric("BadRequest", badRequest).label("platform", platform).get())
        formatter.addMetric(helper.metric("responseTime", lhr.audits["server-response-time"]?.numericValue || 0.0).label("platform", platform).get())
        formatter.addMetric(helper.metric("loadTime", loadTime).label("platform", platform).get())
        formatter.addMetric(helper.metric("transferResourceSize", resourceTotalSize).label("platform", platform).get())
        formatter.addMetric(helper.metric("transferTransferSize", transferTotalSize).label("platform", platform).get())
        formatter.addMetric(helper.metric("largestContentfulPaintTime", lhr.audits["largest-contentful-paint"].numericValue || 0.0).label("platform", platform).get())
        formatter.addMetric(helper.metric("performance", (lhr.categories?.performance?.score || 0.55) * 100).label("platform", platform).get())
        formatter.addMetric(helper.metric("firstContentfulPaintTime", lhr.audits["first-contentful-paint"].numericValue || 0.0).label("platform", platform).get())
        formatter.addMetric(helper.metric("speedIndexTime", lhr.audits["speed-index"]?.numericValue || 0.0).label("platform", platform).get())
        formatter.addMetric(helper.metric("totalBlockingTime", lhr.audits["total-blocking-time"]?.numericValue || 0.0).label("platform", platform).get())

        /**
         * Now for the logs if any, audit output like
         *  {
         *    error: 0,
         *    warn: 0,
         *    info: 4,
         *    hasDebug: false,
         *    entries: [{
         *      eventType: 'consoleAPI',
         *      source: 'console.log',
         *      level: 'info',
         *      text: 'MODE aio',
         *      timestamp: 1706236367557.921,
         *      url: 'http://gate.zervice.cn:1080/umi.89349023.js',
         *      lineNumber: 1,
         *      columnNumber: 642074
         *    }, ...]
         *  }
         */
        const fullPageScreenshotData = lhr.fullPageScreenshot?.screenshot.data;
        if (fullPageScreenshotData) {
            formatter.addEvent(helper.event('spm-webservice-page-load-screenshot', false)
                .catalogs('UserExperience/Function')
                .label("_platform", platform)
                .level(EventLevel.Info)
                .data(lhr.fullPageScreenshot.screenshot.data).get())
        }

        const consoleLogs = lhr.audits["zp-console-log"]?.details || {};
        const entries = consoleLogs.entries || [];
        if(entries.length === 0) {
            logger.info("######## No console logs collected");
        }
        else {
            logger.info("######## Collected " + entries.length + " console logs");
        }

        entries.forEach(entry => {
            formatter.addChunk(helper.chunk()
                .label("platform", platform)
                .label("type", entry.eventType)
                .label("source", entry.source)
                .label("level", entry.level)
                .append(entry.timestamp, JSON.stringify({
                    message: entry.text,
                    url: entry.url,
                    stacktrace: entry.stacktrace,
                    lineNumber: entry.lineNumber,
                    columnNumber: entry.columnNumber
                })).get())
        })


        const resourceSummary = lhr.audits["resource-summary"]?.details?.items || [];
        resourceSummary.forEach(entry => {
            formatter.addMetric(helper.metric("resourceCount", entry.requestCount).label('datatype', entry.label).label("platform", platform).get())
            formatter.addMetric(helper.metric("resourceTransferSize", entry.transferSize).label('datatype', entry.label).label("platform", platform).get())
        })
        // processing resourceTypes
        for (const [type, info] of Object.entries(networkRequests)) {
            formatter.addMetric(helper.metric("requestCount", info.requestCount).label("datatype", type).label("platform", platform).get())
            formatter.addMetric(helper.metric("cacheRequest", info.cacheRequest).label("datatype", type).label("platform", platform).get())
            formatter.addMetric(helper.metric("badRequest", info.badRequest).label("datatype", type).label("platform", platform).get())
            formatter.addMetric(helper.metric("transferResourceSize", info.totalResourceSize).label("datatype", type).label("platform", platform).get())
            formatter.addMetric(helper.metric("transferTransferSize", info.totalTransferSize).label("datatype", type).label("platform", platform).get())
        }

        if (loadTime > (2 * maxLoadTime)) {
            formatter.updateEvent(statusResponseTime.state(1).level(EventLevel.Error).data((isMobile ? 'Mobile page' : 'Page') + ' is too slow to load').get())
            formatter.updateMetric("CheckStatus", EventLevel.Error.ordinal())
            logger.warn('Found too large load time %f for lighthouse result on %s website %s', loadTime, platform, url)
        }
        else if (loadTime > maxLoadTime) {
            formatter.updateEvent(statusResponseTime.state(2).level(EventLevel.Warn).data((isMobile ? 'Mobile page' : 'Page') + ' is slow to load').get())
            formatter.updateMetric("CheckStatus", EventLevel.Warn.ordinal())
            logger.warn('Found large load time %f for lighthouse result on %s website %s', loadTime, platform, url)
        }

        if(info.redirectUrl) {
            formatter.updateEvent(statusEvent.state(2).level(EventLevel.Warn).data((isMobile ? 'Mobile page' : 'Page') + ' redirects to ' + info.redirectUrl).get())
            formatter.updateMetric("CheckStatus", EventLevel.Warn.ordinal())
        }

    } finally {
        // release chrome instance
        await chrome.close()
    }
}

const main = async() => {
    let url = landingUrl;
    if (!/^https?:\/\//i.test(url)) {
        url = 'http://' + url;
    }

    if(uri && uri !== '') {
        url += uri;
    }

    if (!params.disableDesktop) {
        logger.info('Collect desktop performance: ' + url)
        await collect(url, website, 'desktop')
    }

    if (!params.disableMobile) {
        logger.info('Collect mobile performance: ' + url)
        await collect(url, website, 'mobile')
    }

    return formatter.json()
}

main()
