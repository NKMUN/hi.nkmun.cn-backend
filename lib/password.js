'use strict'

const {pbkdf2Sync, randomBytes} = require('crypto')
const ROUNDS = 10000
const LENGTH = 32
const DIGEST = 'sha256'

function getSalt(bytes = 12) {
    return randomBytes(bytes)
}

function derive(password) {
    let salt = getSalt()
    let hash = pbkdf2Sync(String(password), salt, ROUNDS, LENGTH, DIGEST).toString('hex')
    return {salt: salt.toString('base64'), hash, iter: ROUNDS}
}

function verify(password, {salt, hash, iter=ROUNDS}) {
    if (!salt || !hash)
        return false
    else
        return pbkdf2Sync(String(password), Buffer.from(salt, 'base64'), ROUNDS, LENGTH, DIGEST).toString('hex') === hash
}

module.exports = {
    derive,
    verify
}
