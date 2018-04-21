const Router = require('koa-router')
const route = new Router()

const getPayload = require('./lib/get-payload')
const { LogOp } = require('../lib/logger')
const { sign } = require('jsonwebtoken')
const { newId } = require('../lib/id-util')

const AUTHORIZATION_PREFIX = 'Bearer '
const Password = require('../lib/password')
const JWT_OPTS = { expiresIn: '6h' }

const { AccessFilter, TokenParser, InjectHasAccessTo } = require('./auth')

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

        if ( storedCred.active !== undefined && !storedCred.active ) {
            ctx.status = 403
            ctx.body = { message: 'Account not activated' }
            return
        }

        let cred = {
            user: storedCred._id,
            access: storedCred.access || [],
            school: storedCred.school || null,
            session: storedCred.session || null
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
    AccessFilter('admin'),
    async ctx => {
        ctx.status = 200
        ctx.body = await ctx.db.collection('user').aggregate([
            { $lookup: {
                localField: 'school',
                foreignField: '_id',
                from: 'school',
                as: 'school'
            } },
            { $lookup: {
                localField: 'session',
                foreignField: '_id',
                from: 'session',
                as: 'session'
            } }
        ]).map( $ => ({
            id: $._id,
            uid: $.uid,
            active: $.active,
            reserved: $.reserved,
            access: $.access,
            school: $.school && $.school.length > 0
                ? { id: $.school[0]._id, name: $.school[0].school.name }
                : null,
            session: $.session && $.session.length > 0
                ? { id: $.session[0]._id, name: $.session[0].name }
                : null
        }) ).toArray()
    }
)

route.patch('/users/:id',
    AccessFilter('admin'),
    LogOp('user', 'patch'),
    async ctx => {
        const {
            password,
            active
        } = getPayload(ctx)

        const user = await ctx.db.collection('user').findOne({ _id: ctx.params.id })

        if (user.reserved) {
            ctx.status = 403
            ctx.body = { error: 'insufficient priviledge' }
            return
        }

        if (password) {
            await ctx.db.collection('user').updateOne(
                { _id: ctx.params.id },
                { $set: {
                    ...Password.derive(password),
                    lastModified: new Date()
                } }
            )

            ctx.log.payload = { }

            ctx.status = 200
            ctx.body = { }
            return
        }

        if (active) {
            await ctx.db.collection('user').updateOne(
                { _id: ctx.params.id },
                { $set: {
                    active,
                    lastModified: new Date(),
                } }
            )
            ctx.status = 200
            ctx.body = { }
            return
        }

        ctx.status = 400
        ctx.body = { error: 'bad request' }
    }
)

// Unified Registration
route.post('/users/',
    LogOp('user', 'register'),
    InjectHasAccessTo,
    async ctx => {
        const { email, password, access, session: _session, school: _school } = getPayload(ctx)

        const user = await ctx.db.collection('user').findOne({ _id: email })
        if (user) {
            ctx.status = 409
            ctx.body = { error: 'already exists' }
            return
        }

        // root can not be created at all time
        // admin can only be created by root
        const wantToCreateRoot = access.includes('root')
        const wantToCreateAdmin = access.includes('admin')
        if ( wantToCreateRoot || (wantToCreateAdmin && !ctx.hasAccessTo('root')) ) {
            ctx.status = 400
            ctx.body = { error: 'can not esclate priviledges' }
            return
        }

        // transient access does not require staff verification
        // admins can do whatever they want
        const isNotTransientAccess = access.find(accessStr => !accessStr.startsWith('transient.'))
        const needStaffVerification = isNotTransientAccess && !ctx.hasAccessTo('admin')

        // school / session can only be set by admins
        if (!ctx.hasAccessTo('admin') && (_school || _session)) {
            ctx.status = 400
            ctx.body = { error: 'can not set school or session' }
            return
        }

        const uid = newId()
        const active = needStaffVerification ? false : true
        const school = _school || null
        const session = _session || null

        await ctx.db.collection('user').insertOne({
            _id: email,
            uid: uid,
            access: access,
            reserved: false,
            created: new Date(),
            session,
            school,
            active,
            ...Password.derive(password)
        })

        ctx.status = 200
        ctx.body = {
            message: 'success',
            user: email,
            id: email,
            active,
            uid,
            token: active ? sign({
                user: email,
                access,
                school,
                session
            }, ctx.JWT_SECRET, JWT_OPTS) : null
        }
    }
)

route.head('/users/:id',
    async ctx => {
        const user = await ctx.db.collection('user').findOne({ _id: ctx.params.id })
        if (user) {
            ctx.status = 200
            ctx.set('X-User-Exists', '1')
        } else {
            ctx.status = 200
        }
    }
)

route.delete('/users/:id',
    AccessFilter('admin'),
    async ctx => {
        const user = await ctx.db.collection('user').findOne({ _id: ctx.params.id })
        if (!user) {
            ctx.status = 404
            ctx.body = { error: 'not found' }
            return
        }
        if (user.reserved) {
            ctx.status = 403
            ctx.body = { error: 'user is reserved' }
            return
        }
        await ctx.db.collection('user').deleteOne({ _id: ctx.params.id })
        ctx.status = 200
        ctx.body = { message: 'success' }
    }
)

module.exports = {
    routes: route.routes()
}
