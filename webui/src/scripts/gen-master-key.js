const crypto = require('crypto');

const key = crypto.randomBytes(32).toString('base64');
process.stdout.write(key + '\n');
