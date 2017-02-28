const Router = require('koa-router')
const route = new Router()

const getPayload = require('./lib/get-payload')
const { LogOp } = require('../lib/logger')
const { sign } = require('jsonwebtoken')

const AUTHORIZATION_PREFIX = 'Bearer '
const Password = require('../lib/password')
const JWT_OPTS = { expiresIn: '3d' }

route.post('/login',
    LogOp('auth', 'login'),
    async (ctx) => {
        const { db, JWT_SECRET } = ctx
        const { user, password } = getPayload(ctx)

        let storedCred = await db.collection('user').findOne({ _id: user })

        if ( !storedCred || !Password.verify(password, storedCred) ) {
            ctx.status = 401
            ctx.body = { message: 'Invalid credential' }
            ctx.set('WWW-Authenticate', AUTHORIZATION_PREFIX+'token_type="JWT"')
            return
        }

        let cred = {
            user: storedCred._id,
            access: storedCred.access || [],
            school: storedCred.school || null
        }

        // surpass payload that contains password
        ctx.log.payload = { user }
        ctx.log.user = user
        ctx.log.issuedToken = cred
        ctx.status = 200
        ctx.body = {
            user,
            token: sign(cred, JWT_SECRET, JWT_OPTS)
        }
    }
)

module.exports = {
    routes: route.routes()
}
