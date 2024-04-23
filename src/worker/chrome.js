const {defaultOpts, ChromeWrapper} = require('libs/chrome');
const { v4: uuidv4 } = require('uuid')

const logger = require('libs/logger').get('chrome');

//
// pending open or close requests, map uuid to wrapper futures (promises)
const state = {
    open: {

    },
    close: {

    }
}

/**
 * Handling response by uuid
 */
const handle_response = (pendings, uuid, data, err) => {
    const promise = pendings[uuid];
    delete pendings[uuid];

    if(promise) {
        // clear timeout set in request
        clearTimeout(promise.timeout)

        if(err) {
            promise.reject(err)
        }
        else {
            promise.resolve(data)
        }
    }
    else {
        logger.warn("Got response for unknown request - " + uuid);
    }
}

/**
 * Send request to open or close a chrome session
 * @param runtime
 * @param type - chrome-open or chrome-close
 * @param pendings - pending requests
 * @param uuid
 * @param payload - chrome open options or port #
 */
const make_request = (runtime, type, pendings, uuid, payload) => {
    runtime.send(type, payload)

    return new Promise((resolve, reject) => {
        // don't wait too long
        const timeout = setTimeout(() => handle_response(pendings, uuid, false, new Error("Timeout request - " + uuid)), 3000)

        pendings[uuid] = {
            resolve,
            reject,
            timeout,
        }

    })
}

/**
 * Remote chrome wrapper
 */
class RemoteChromeWrapper extends ChromeWrapper {
    runtime = null
    uuid = null
    key = null     // key is unmodified opts to uniquely identify the chrome pool
    port = null
    options = null  // options might be modified by the lib. We need this options to pass to lighthouse or puppeteer, etc.

    constructor(runtime) {
        super();
        this.runtime = runtime
        this.uuid = uuidv4()
    }

    getOptions() {
        return this.options
    }

    // return a chrome instance
    async open(opts) {
        opts = opts || {}
        delete opts.port   // get rid of port
        this.key = {...opts}

        // get port and options...
        this.options = await make_request(this.runtime, 'chrome-open', state.open, this.uuid, {uuid: this.uuid, options: this.key})

        this.port = this.options.port

        logger.info("Remote chrome instance with port %d opened", this.port)

        return this.options
    }

    async close() {
        if (!this.port) {
            return
        }

        const port = this.port
        this.port = null

        await make_request(this.runtime, 'chrome-close', state.close, this.uuid, {uuid: this.uuid, options: this.key, port})

        logger.info("Remote chrome instance with port %d closed", port)
    }

    static async on_open_response(type, payload) {
        const {uuid, options, err} = payload;
        logger.info("Got open response for request - " + uuid)
        handle_response(state.open, uuid, options, err)
    }

    static async on_close_response(type, payload) {
        const {uuid, result, err} = payload;
        logger.info("Got close response for request - " + uuid)
        handle_response(state.close, uuid, result, err)
    }
}

module.exports = RemoteChromeWrapper;