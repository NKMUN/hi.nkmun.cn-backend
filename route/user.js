const Router = require('koa-router')
const route = new Router()

const getPayload = require('./lib/get-payload')
const { LogOp } = require('../lib/logger')
const { sign } = require('jsonwebtoken')

const AUTHORIZATION_PREFIX = 'Bearer '
const Password = require('../lib/password')
const JWT_OPTS = { expiresIn: '3d' }

const { AccessFilter } = require('./auth')

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

route.get('/users/',
    AccessFilter('admin', 'root'),
    async ctx => {
        ctx.status = 200
        ctx.body = await ctx.db.collection('user').aggregate([
            { $lookup: {
                localField: 'school',
                foreignField: '_id',
                from: 'school',
                as: 'school'
            } }
        ]).map( $ => ({
            id: $._id,
            reserved: $.reserved,
            access: $.access,
            school: $.school && $.school.length > 0
                  ? { id: $.school[0]._id, name: $.school[0].school.name }
                  : null
        }) ).toArray()
    }
)

route.patch('/users/:id',
    AccessFilter('admin', 'root'),
    async ctx => {
        const {
            password
        } = getPayload(ctx)

        const user = await ctx.db.collection('user').findOne({
            _id: { $eq: ctx.params.id }
        })

        if (user.reserved) {
            ctx.status = 403
            ctx.body = { error: 'insufficient priviledge' }
            return
        }

        if (password) {
            let userUpdate = Object.assign(
                require('../lib/password').derive(password),
                { lastModified: new Date() }
            )

            await ctx.db.collection('user').updateOne(
                { _id: { $eq: ctx.params.id } },
                { $set: userUpdate }
            )

            ctx.log.payload = { }

            ctx.status = 200
            ctx.body = { }
            return
        }

        ctx.status = 400
        ctx.body = { error: 'bad request' }
    }
)

module.exports = {
    routes: route.routes()
}
