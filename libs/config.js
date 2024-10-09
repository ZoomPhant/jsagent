const root = process.env.AGENT_ROOT || '/usr/local/zoomphant/agent';

/**
* A configuration like
* {
*   "role": "slave",
*   "cluster": true,
*   "port": 9099,
*   "server": {
*       "cloudMode": false,
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
    
    if(server.secure) {
        if(server.port === 0 || server.port === 443) {
            return 'https://' + server.host + server.baseUrl;
        }
        else {
            return 'https://' + server.host + ":" + server.port + server.baseUrl;
        }
    }
    else {
        if(server.port === 0 || server?.port === 443) {
            return 'http://' + server.host + server.baseUrl;
        }
        else {
            return 'http://' + server.host + ":" + server.port + server.baseUrl;
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