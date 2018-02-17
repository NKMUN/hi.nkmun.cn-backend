const Router = require('koa-router')
const route = new Router()
const { readFile, unlink } = require('mz/fs')
const getPayload = require('./lib/get-payload')
const { AccessFilter } = require('./auth')
const { newId, toId } = require('../lib/id-util')

route.post('/daises/',
    async ctx => {
        const payload = getPayload(ctx)
        let {
            insertedId
        } = await ctx.db.collection('dais').insertOne({
            _id: newId(),
            login: {
                user: payload.contact.email,
                ...require('../lib/password').derive(payload.password)
            },
            ...getPayload(ctx),
            password: undefined,
            created_at: new Date()
        })

        ctx.status = 200
        ctx.body = {
            id: insertedId
        }
    }
)

route.get('/daises/',
    AccessFilter('admin'),
    async ctx => {
        const daises = await ctx.db.collection('dais').find({}, { login: false }).toArray()
        ctx.status = 200
        ctx.body = daises.map(toId)
    }
)

route.post('/daises/:id',
    AccessFilter('admin'),
    async ctx => {
        const {
            activate,
            reject
        } = getPayload(ctx)

        if (activate) {
            const dais = await ctx.db.collection('dais').findOne({ _id: ctx.params.id })
            if (!dais) {
                ctx.status = 404
                ctx.body = { error: 'not found' }
                return
            }
            const {
                login,
                session
            } = dais
            try {
                await ctx.db.collection('user').insertOne({
                    ...login,
                    _id: login.user,
                    access: ['dais'],
                    reserved: false,
                    session: session,
                    school: null,
                    created: new Date()
                })
            } catch(e) {
                // duplicate
                ctx.status = 409
                ctx.body = { error: 'already exists' }
                return
            }
            await ctx.db.collection('dais').updateOne(
                { _id: ctx.params.id },
                { $set: { state: 'activated' } }
            )
            ctx.status = 200
        }

        if (reject) {
            await ctx.db.collection('dais').updateOne(
                { _id: ctx.params.id },
                { $set: { state: 'rejected' } }
            )
            ctx.status = 200
        }

        if (ctx.status === 200) {
            ctx.body = toId(
                await ctx.db.collection('dais').findOne({ _id: ctx.params.id }, { login: false })
            )
        }
    }
)

const Dais = async (ctx, next) => {
    // dais can only get themself
    if (ctx.hasAccessTo('dais')) {
        if (ctx.params.id !== '~') {
            ctx.status = 403
            ctx.body = { error: 'forbidden' }
            return
        }
    }

    const dais = await ctx.db.collection('dais').findOne(
      ctx.params.id === '~'
        ? { state: 'activated', 'login.user': ctx.token.user }
        : { _id: ctx.params.id },
      { 'login.hash': false, 'login.salt': false, 'login.iter': false }
    )
    if (!dais) {
        ctx.status = 404
        ctx.body = { error: 'not found' }
        return
    }

    ctx.dais = dais
    if (next) await next()
}

const Route_GetDaisById = async ctx => {
    await Dais(ctx),
    ctx.status = 200
    ctx.body = toId(ctx.dais)
}

route.get('/daises/:id',
    AccessFilter('dais', 'admin', 'finance'),
    Route_GetDaisById
)

route.patch('/daises/:id',
    AccessFilter('dais', 'admin', 'finance'),
    Dais,
    async ctx => {
        const payload = getPayload(ctx)
        const PERMITTED_FIELDS = [
            'photoId',
            'identification',
            'guardian',
            'guardian_identification',
            'comment',
            'arriveDate',
            'departDate',
            'checkInDate',
            'checkOutDate'
        ]
        for (let key in payload) {
            if (!PERMITTED_FIELDS.includes(key)) {
                ctx.status = 400
                ctx.body = { error: 'not permitted', message: `can not update field: ${key}` }
                return
            }
        }

        await ctx.db.collection('dais').updateOne(
            { _id: ctx.dais._id },
            { $set: payload }
        )

        await Route_GetDaisById(ctx)
    }
)

module.exports = {
    routes: route.routes()
}
