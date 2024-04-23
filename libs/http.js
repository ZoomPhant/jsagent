/**
 * handlie HTTP protocol
 */
const axios = require('axios');
const config = require('libs/config')

axios.defaults.baseURL = config.getBaseURL()

// request will timeout in 5 seconds
axios.defaults.timeout = 5000;

/**
 * Helper to check if response is OK. If not throw an error, otherwise return the response data
 */
const _check = res => {
    if(res.status !== 200) {
        throw new Error(res.status + ": " + res.statusText);
    }

    return res.data
}

/**
 * Get data from url with query params
 */
const get = async (url, config)  => {
    const res = await axios.get(url, config)
    return _check(res)
}

/**
 *  Post data to url with query params
 */
const post = async (url, data, config) => {
    const res = await axios.post(url, data, config)
    return _check(res)    
}

module.exports = {
    get, post
}

