const root = process.env.AGENT_ROOT || '/usr/local/zoomphant/agent';

/**
* A configuration like
* {
*   "role": "slave",
*   "cluster": true,
*   "port": 9099,
*   "server": {
*       "cloudMode": false,
*       "address": "demo.zervice.us",
*       "host": "demo.zervice.us",
*       "port": "443",
*       "baseUrl": "/",
*       "secure": true
*   },
*   "httpd": {
*     "enabled": true,
*     "secure": false
*   },
*   "workers": {
*     "mode": "active",
*     "count": 2
*   },
*   "technology": {
*     "sync": false
*   }
* }
*/
const config = require(root + '/conf/config.json');

if(config.mode === 'mock') {
    console.log('******** Collector running in MOCK mode ********')
}

if(config.role === 'slave') {
    console.log('******** Collector running in SLAVE role ********')
}

config.getBaseURL = () => {
    const server = config.server || {
        host: '127.0.0.1',
        port: 80,
        secure: false,
        baseUrl: '/'
    }
    
    /**
     * In our config.json we may have address and host
     *   host    - The host to connect, will also be used as HOST header in request, must HAVE
     *   address - the dns or IP to connect to, optional. If missing it would be the same as host
     */
    const host = server.address || server.host || '127.0.0.1';
    if(server.secure) {
        if(server.port === 0 || server.port === 443) {
            return 'https://' + host + server.baseUrl;
        }
        else {
            return 'https://' + host + ":" + server.port + server.baseUrl;
        }
    }
    else {
        if(server.port === 0 || server?.port === 443) {
            return 'http://' + host + server.baseUrl;
        }
        else {
            return 'http://' + host + ":" + server.port + server.baseUrl;
        }
    }
}

config.getRoot = () => root

/**
* Worker work mode
*    passive - worker work in passive mode, master dispatch task to and worker send back result, default
*    active  - worker work in active mode, worker poll for task and if got set back result
* @returns {boolean}
*/
config.isWorkerPassive = () => {
    const mode = config?.workers?.mode || "passive";
    return mode === "passive";
}

module.exports = config;