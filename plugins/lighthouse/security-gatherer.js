const Logger = require('libs/logger')

module.exports = import('lighthouse').then(({Gatherer}) => {
    const logger = Logger.get("audit")

    // const dummyRequestHandler = (request) => request.continue()
    // const dummyRequestFailureHandler = (request) => {}

    class ConsoleMessages extends Gatherer {
        meta = {
            supportedModes: ['timespan', 'navigation'],
        };

        constructor() {
            super();
            this._secEntries = [];
            // this._page = null;
            this._headers = null;

            this._onRequestFinish = this.onRequestFinish.bind(this)
        }

        /*
        async _stopIntercepting() {
            if(this._page) {
                await this._page.setRequestInterception(false);
                this._page.off('request', dummyRequestHandler)
                this._page.off('requestfinished', this._onRequestFinish)
                this._page.off('requestfailed', dummyRequestFailureHandler)

                this._page = null;
            }
        }
        */

        /**
         * We cannot count on networkMonitor's responseHeaders, as it would "eat" some headers, let's
         * parse from responseHeadersText directly
         *
         * Treat Set-Cookie specifically as we may receive multiple ones but with different cookie-names
         * For this case, we just concaternate them togethers ...
         * @param headersText
         * @private
         */
        _parseHeaders(headersText) {
            const headerLines = headersText.split(/\r?\n/).slice(1, headersText.indexOf('\n\n'));

            this._headers = headerLines.reduce((headers, line) => {
                const [key, value] = line.split(': ');
                if('set-cookie' === key.toLowerCase()) {
                    if(headers.hasOwnProperty('Set-Cookie')) {
                        headers['Set-Cookie'] = headers['Set-Cookie'] + "\n" + value
                    }
                    else {
                        headers['Set-Cookie'] = value
                    }
                }
                else {
                    headers[key] = value
                }

                return headers;
            }, {})

            // console.log('######## Got headers\n' + JSON.stringify(this._headers, null, 2))
        }

        async onRequestFinish(request) {
            // console.log('@@@@@@@ request done', request)

            if(this._headers == null && request.statusCode === 200 && request.requestMethod === 'GET' && request.resourceType === 'Document') {
                /*
                this._headers = (request.responseHeaders || []).reduce((headers, header) => {
                    headers[header.name] = header.value;
                    return headers;
                }, {});

                console.log('######## Got headers\n' + JSON.stringify(this._headers, null, 2))
                */
                this._parseHeaders(request.responseHeadersText)

                // logger.info("######## Got headers - " + JSON.stringify(this._headers))
            }

            /*
                const response = await request.response();
                // console.log("######## Got response and headers - " + request.url() + " with status " + response.status(), response.headers())
                if(response.ok()) {
                    this._headers = response.headers()
                    for(const key in this._headers) {
                        console.log("######## Got headre " + key + "=" + this._headers[key])
                    }

                    // this._headers =
                    // we got the first OK response, let's just stop
                    await this._stopIntercepting();
                }
            */
        }

        async startInstrumentation({driver, page}) {
            try {
                logger.debug("Start security instrumentation ...")
                const networkMonitor = driver.networkMonitor

                await networkMonitor.enable()
                /*
                networkMonitor.on('requeststarted', (req) => {
                    // console.log('######### request start', req)
                })
                */

                networkMonitor.on('requestfinished', this._onRequestFinish);
            }
            catch(e) {
                logger.error(e, 'error enable network monitor')
            }

            /*
            await page.setRequestInterception(true);

            page.on('request', dummyRequestHandler)
            page.on('requestfinished', this._onRequestFinish)
            page.on('requestfailed', dummyRequestFailureHandler)

            this._page = page
            */
        }

        async stopInstrumentation({driver, page}) {
            logger.info("######## Stop security instrumentation ...")

            await driver.networkMonitor.disable()

            /*
            driver.networkMonitor.off('requeststarted', (req) => {
                // console.log('######### request start', req)
            })
            */

            driver.networkMonitor.off('requestfinished', this._onRequestFinish)

            /*
            try {
                const node = await page.$('head meta[name="generator"]')
                console.log("######### Generator ", node)

                const url = await driver.executionContext.evaluateAsync('window.location.href')
                const metaSelector = 'meta[http-equiv=Content-Security-Policy]';
                const result = await driver.executionContext.evaluateAsync(`window.document.querySelectorAll('${metaSelector}')`);
                console.log('@@@@@@@@ META selector - ' + url, result)
            }
            catch(e) {
                console.log('@@@@@@@@@ error', e)
            }
            */

            // await this._stopIntercepting()
        }

        async getArtifact() {
            return this._secEntries;
        }
    }

    return ConsoleMessages;
})
