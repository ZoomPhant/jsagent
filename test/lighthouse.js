// Main lighthouse runner / fn
require('app-module-path').addPath(__dirname + "/..");

const fs = require('fs')
const lighthouse = require('libs/lighthouse');
const ChromeWrapper = require('src/main/chrome');

// Required for launching chrome instance
const chrome = new ChromeWrapper()

// So we can save output
const {writeFile} = require('fs/promises');

const flags = {
    chromeFlags: ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors', '--disable-translate']
};

const config = {
    'mobile': {
        maxWaitForFcp: 15 * 1000,
        maxWaitForLoad: 35 * 1000,
        // lighthouse:default is mobile by default
        // Skip the h2 audit so it doesn't lie to us. See https://github.com/GoogleChrome/lighthouse/issues/6539
        // skipAudits: ['uses-http2'],
        
        // our stuff
        screenEmulation: {
            mobile: true,
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            disabled: false
        },
        formFactor: 'mobile',
        emulatedUserAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
        // screenEmulation: constants.screenEmulationMetrics.mobile,
        // emulatedUserAgent: constants.userAgents.mobile,
        
        output: 'json',
        disableStorageReset: true,
        chromeFlags: ['--disable-application-cache', '--disable-cache'],
        emulatedFormFactor: 'mobile',
        onlyCategories: ['performance'],
        onlyAudits: ['server-response-time', 'network-requests', 'interactive', 'largest-contentful-paint', 'first-contentful-paint', 'speed-index', 'total-blocking-time'],
    },
    'desktop': {
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
        chromeFlags: ['--disable-application-cache', '--disable-cache'],
        screenEmulation: {
            mobile: false,
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
            disabled: false
        },
        emulatedUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        emulatedFormFactor: 'desktop',
        onlyCategories: ['performance'],
        onlyAudits: ['server-response-time', 'network-requests', 'interactive', 'largest-contentful-paint', 'first-contentful-paint', 'speed-index', 'total-blocking-time'],
        // quiet: true,
    }
}

const collect = async(url, options, waitTimeout) => {
    console.log('Open Chrome tab from - ' + url)
    return lighthouse(url, {
        ...options, waitTimeout
    }, {
        extends: 'lighthouse:default',
        settings: {
            onlyCategories: ['performance']
        }
    }).finally(() => {
        console.log('Close Chrome tab from - ' + url)
    });
}

(async () => {
    console.log('Try collect www.bing.com ...')
    
    const url = 'https://www.bing.com'
    await chrome.open()
    try {
        {
            const prom = collect(chrome, {...config.mobile, port: chrome.getOptions().port}, url, 10000)
            const result = await prom;
            
            const jsonString = JSON.stringify(result, null, 2);
            fs.writeFile('mobile.json', jsonString, (err) => {
                if (err) {
                    console.error('Error writing file:', err);
                } else {
                    console.log('File written successfully');
                }
            });
        }
        {
            const prom = collect(chrome, {...config.desktop, port: chrome.getOptions().port}, url, 10000)
            const result = await prom;
            
            const jsonString = JSON.stringify(result, null, 2);
            fs.writeFile('desktop.json', jsonString, (err) => {
                if (err) {
                    console.error('Error writing file:', err);
                } else {
                    console.log('File written successfully');
                }
            });
        }
    }
    catch(err) {
        console.log('Error processing www.bing.com', err)
    }
    finally {
        chrome.close()
    }
})();
