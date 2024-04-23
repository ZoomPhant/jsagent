const {connect, disconnect, defaultOpts, ChromeWrapper} = require('libs/chrome');

const logger = require('libs/logger').get('chrome');

class LocalChromeWrapper extends ChromeWrapper {
    key = null     // key is unmodified opts to uniquely identify the chrome pool
    chrome = null
    options = null  // options might be modified by the lib. We need this options to pass to lighthouse or puppeteer, etc.

    constructor() {
        super();
    }

    getOptions() {
        return this.options
    }

    // return a chrome instance
    async open(opts) {
        opts = opts || {}
        delete opts.port   // get rid of port
        this.key = {...defaultOpts, ...opts}
        this.options = {...this.key}

        this.chrome = await connect(this.key, this.options)

        this.options.port = this.chrome.port

        return this.chrome
    }

    async close() {
        if (!this.chrome) {
            return
        }

        const chrome = this.chrome
        this.chrome = null

        await disconnect(this.key, chrome)
    }

    static async do_connect(opts) {
        const key = {...defaultOpts, ...opts }
        const options = { ... key }

        const chrome = await connect(key, options )
        options.port = chrome.port;

        return options;
    }

    static async do_disconnect(opts, port) {
        const key = {...defaultOpts, ...opts }

        await disconnect(key, port)
    }
}

module.exports = LocalChromeWrapper;