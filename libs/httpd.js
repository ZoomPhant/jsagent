const http = require('http');
const util = require('util');
const zlib = require('zlib');
const Logger = require('libs/logger')
const config = require('libs/config')

const logger = Logger.get("httpd")

/**
 * Here we create a HTTP server. NodeJS won't handle HTTPS, if we need secure layer,
 * we shall put this behind a proxy like Nginx to handle HTTPS stuff.
 *
 * handlers map of url to handler functions like
 *    /api/execute => (req, res)
 */

const handlers = {}

const start = () => {
    const enabled = config.httpd?.enabled || false;

    const host = (enabled ? config.httpd?.host : config.host) || '0.0.0.0';
    const port = (enabled ? config.httpd?.port : config.port) || 8000;

    const deflate = util.promisify(zlib.deflate);
    const inflate = util.promisify(zlib.inflate);
    const gzip = util.promisify(zlib.gzip);
    const gunzip = util.promisify(zlib.gunzip);

    //
    // if a handler is registered for a URL, call it, otherwise just return 403
    const requestListener = async function (req, res) {
        const handler = handlers[req.url]
        if (handler) {
            try {
                const buffers = [];

                for await (const chunk of req) {
                    buffers.push(chunk);
                }

                let body = Buffer.concat(buffers)

                // check if body is encoded some how, i.e. deflated or gzipped
                const header = req.headers['content-encoding'];
                if (header) {
                    if (header.match(/\bdeflate\b/)) {
                        body = await inflate(body)
                    } else if (header.match(/\bgzip\b/)) {
                        body = await gunzip(body)
                    }
                }

                // save body in req ...
                req.body = body.toString();

                const ret = handler(req, res)

                // wait handler processing done as above might be a promise!
                await Promise.resolve(ret);

                body = Buffer.from(res.body || '', 'utf8');
                if (body.length > 1024) {
                    // gzip large body
                    res.setHeader("Content-Encoding", "gzip");
                    body = await gzip(res.body)
                }

                if (!res.hasHeader("Content-Type")) {
                    // default to json
                    res.setHeader("Content-Type", "application/json");
                }

                res.writeHead(200);
                res.end(body);
            } catch (e) {
                logger.warn('Error processing ' + req.url, e)
                res.writeHead(503, "Error processing request - " + e.message)
                res.end();
            }
        } else {
            res.writeHead(403, "Access Denied");
            res.end();
        }
    };

    const server = http.createServer(requestListener);

    server.listen(port, host, () => {
        logger.info("Start HTTPD on %s:%d ...", host, port)
    });

    return true;
}

module.exports = {
    start,

    register: (url, func) => {
        handlers[url] = func;
    }
}