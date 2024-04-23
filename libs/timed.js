/**
 * A helper class to wrap a promise with a timeout
 */
const {TimeoutError} = require('libs/errors')

/**
 * A helper to wait a promise with
 * @param resolve - promise resolver
 * @param reject - promise rejector
 * @param timeoutMillis - timeout in milliseconds
 * @param cleanup - cleanup function when timedout
 * @param message - messages for timeout
 * @returns {{resolve: *, reject: *, timeout: number}}
 */
module.exports = (resolve, reject, timeoutMillis, cleanup = () => {}, message) => {
    const timeout = setTimeout(() => {
        console.log("######## Fire timeout - " + timeout + " with time " + timeoutMillis + "ms for " + message);
        cleanup()
        reject(new TimeoutError(message || "Timed out"))
    }, timeoutMillis);

    console.log("######## Create timeout - " + timeout + " with time " + timeoutMillis + "ms for " + message);

    return {
        resolve: (...args) => {
            console.log("######## Clear timeout with resolved - " + timeout);
            clearTimeout(timeout)
            resolve(...args);
        },
        reject: (...args) => {
            console.log("######## Clear timeout with rejection - " + timeout);
            clearTimeout(timeout)
            reject(...args);
        },
        timeout
    }
}