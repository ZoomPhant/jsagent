/***
 * NOT USED: level DB cannot be shared cross processes, so it is of little use ....
 * Let's just put everything in memory          
 */
const util = require('util');
const zlib = require('zlib')
const { Level } = require('level')
const { stringify } = require('querystring');

const root = process.env.AGENT_ROOT || '/usr/local/zoomphant/agent';

const dbPath = root + '/tmp/taskdb'

var options = {    
    valueEncoding: 'binary'  
};


const db = new Level(dbPath, options)

const deflate = util.promisify(zlib.deflate);
const inflate = util.promisify(zlib.inflate)

const put = async (key, obj) => {
    const buffer = Buffer.from(JSON.stringify(obj))

    const compressed = await deflate(buffer)
    
    return db.put(key, compressed)
}

const get = async (key) => {
    const compressed = await db.get(key)
    if(compressed) {
        const buffer = await inflate(compressed)

        if (buffer) {
            return JSON.parse(buffer.toString());
        }
    }

    return null;
}

const remove = async (key) => {
    return db.del(key);
}

/**
 * Reset by delete the db and re-create it
 */
const clear = async () => {
    await db.clear()
    /*
    await db.close()
    
    // remote the file
    fs.unlink(dbPath)

    await db.open()
    */
}

// todo: how to get # of entries in the DB?
const size = () => {
    return 0;
}

module.exports = {
    put, get, remove, clear, size
}
