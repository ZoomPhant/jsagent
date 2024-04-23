/**
 * All chrome instances is managed in main process so they can be borrowed by child
 * process and be reused.
 *
 * Logically each child can have at most one chrome instance at a time
 */

const net = require("net")
const _ = require('lodash')
const metrics = require("libs/metrics")
const logger = require('libs/logger').get('chrome');
// const chromeLauncher = requireModule('chrome-launcher');
const launchChrome = (...args) => import('chrome-launcher').then((chromeLauncher) => chromeLauncher.launch(...args));

//
// Instances contains object as follows
// {
//    options: {
//        // chrome flags
//    },
//    instances: [<chrome instance>]
// }
const state = {
    cached: {
        // map stringized key array of chrome instances
    },
    active: {
        // map port to chrome instance
    },
    access: {
        // map port to last used (access) time, if a port is not used for a long time, the instance will be killed
    }
}

const check = async (port) => {
    return new Promise((resolve) => {
        const socket = new net.Socket();

        const onError = (err) => {
            if(err) {
                logger.error("Cannot connect port - " + port + " due to - " + err.message)
            }
            else {
                logger.error("Timeout connect port - " + port)
            }

            socket.destroy();
            resolve(false)
        };

        socket.setTimeout(500);
        socket.once('error', onError);
        socket.once('timeout', onError);

        socket.connect(port, "127.0.0.1", () => {
            logger.info("Chrome instance with port - " + port + " is active")
            socket.end();
            socket.destroy()
            resolve(true);
        });
    })
}

//
// open a chrome with given options. The open will try to use an existing instance
// if any
const connect = async (key, opts) => {
    metrics.count("lighthouse_connect", 1);

    /*
    const chrome = await launchChrome(opts);
    // logger.info({key}, 'Create chrome instance with port ' + chrome.port)
    logger.info('Create chrome instance with port ' + chrome.port)
    state.active[chrome.port] = chrome;
    return chrome
    */

    let cacheKey = JSON.stringify(key)
    if(!state.cached.hasOwnProperty(cacheKey)) {
        logger.info("Create chrome cache with key - " + cacheKey)
        state.cached[cacheKey] = []
    }

    let pool = state.cached[cacheKey];

    do {
        if (pool.length === 0) {
            metrics.count("chrome_start", 1);
            // no instance, just create and return
            const chrome = await launchChrome(opts);
            logger.info('New chrome instance with port ' + chrome.port + ' of cache key - ' + cacheKey)
            state.active[chrome.port] = chrome // save for cleanup
            chrome.process.on('close', (code) => {
                metrics.count("chrome_close", 1);
                logger.warn('Detected closed chrome instance with port ' + chrome.port + ' of cache key - ' + cacheKey);
                delete state.active[chrome.port]
            })

            state.access[chrome.port] = Date.now();
            return chrome
        }

        const chrome = pool.shift()

        const ok = await check(chrome.port)
        if(!ok) {
            logger.info('Found invalid chrome instance with port ' + chrome.port + ' of cache key - ' + cacheKey)
            delete state.active[chrome.port]
            metrics.count("chrome_kill", 1);
            await chrome.kill()
            continue;
        }

        metrics.count("chrome_cache", 1);
        logger.info('Reuse chrome instance with port ' + chrome.port + ' of cache key - ' + cacheKey)
        state.access[chrome.port] = Date.now();
        return chrome
    } while(true);
};

//
// close a chrome. The passed shall be a proxy, so we just try to return the instance
// to cache
//
// This method can be called multiple times, so we can make sure the used chrome could
// be closed properly
const disconnect = async (key, chromeOrPort) => {
    metrics.count("lighthouse_disconnect", 1);
    // logger.info({key}, 'Destroy chrome instance with port ' + chrome.port)
    /*
    logger.info('Destroy chrome instance with port ' + chrome.port)
    delete state.active[chrome.port];
    await chrome.kill()
    */
    let chrome = chromeOrPort; // assume it's a chrome object
    if(typeof chromeOrPort === 'number') {
        chrome = state.active[chromeOrPort]
        if(!chrome) {
            logger.error('Invalid parameter to disconnect chrome ' + chromeOrPort)
            return;
        }
        else {
            logger.info('Found chrome instance with port ' + chromeOrPort)
        }
    }

    const port = chrome.port;

    let cacheKey = JSON.stringify(key)
    if(!state.cached.hasOwnProperty(cacheKey)) {
        logger.warn('Destroy chrome instance with port ' + port + ' of unknown cache key - ' + cacheKey)
        metrics.count("chrome_kill", 1);
        await chrome.kill()
        return;
    }

    if(!state.active.hasOwnProperty(port)) {
        logger.warn('Destroy already closed chrome instance with port ' + port + ' of cache key - ' + cacheKey)
        metrics.count("chrome_kill", 1);
        await chrome.kill()
        return;
    }

    logger.info('Save chrome instance with port - ' + port  + ' of cache key - ' + cacheKey)
    state.cached[cacheKey].push(chrome)
    state.access[port] = Date.now();
}

const defaultOpts = {
    chromeFlags: ['--headless', '--incognito', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors', '--disable-translate'],
    logLevel: 'error',
    output: 'json',
}

const INSTANCE_TIMEOUT_MS = 300 * 1000; // in millis, 5 min

// check very 30 seconds
state.idler = setInterval(async() => {
    for (const [port, lastAccess] of Object.entries(state.access)) {
        const idled  = Date.now() - lastAccess
        if(idled > INSTANCE_TIMEOUT_MS) {
            delete state.access[port];

            const chrome = state.active[port];
            delete state.active[port];

            if(chrome) {
                logger.warn('Cleanup chrome instance with port - ' + port + ' for not used for ' + (idled / 1000) + ' seconds')
                chrome.kill()
            }
            else {
                logger.error('Cleanup non-existing chrome instance with port - ' + port + ' for not used for ' + (idled / 1000) + ' seconds')
            }
        }
    }
}, 30000);

const cleanup = async() => {
    logger.warn("Found active chrome instances - " + Object.keys(state.active))

    const promises = []
    for(const port in state.active) {
        logger.warn("Destroy chrome with port - " + port)

        const chrome = state.active[port];
        promises.push(chrome.kill())
    }

    if(promises.length > 0) {
        try {
            logger.info("Waiting " + promises.length + " chrome instances to be killed ...")
            await Promise.all(promises);
        } catch (err) {
            logger.error(err, "Error killing all chrome instances");
        }
    }
}

/**
 * Base class for wrap chrome instnace
 */
class ChromeWrapper {
    constructor() {
    }

    /**
     * connect to a chrome instance
     * @param opts
     * @returns {Promise<void>}
     */
    async open(opts) {
        // Implement open method
    }

    /**
     * disconnect from the connected instance
     * @returns {Promise<void>}
     */
    async close() {
        // Implement close method
    }

    /**
     * Get options of the chrome so lighthouse can connect to
     */
    getOptions() {
        // Implement getOptions
    }
}

module.exports = {
    connect,
    disconnect,
    cleanup,
    defaultOpts,
    ChromeWrapper,
}
