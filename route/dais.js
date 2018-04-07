const Router = require('koa-router')
const route = new Router()
const { readFile, unlink } = require('mz/fs')
const getPayload = require('./lib/get-payload')
const { AccessFilter } = require('./auth')
const { newId, toId } = require('../lib/id-util')
const { Sessions } = require('./session')

const Dais = async (ctx, next) => {
    // dais can only get themself
    if (ctx.hasAccessTo('dais') && !(ctx.hasAccessTo('admin') || ctx.hasAccessTo('academic_director'))) {
        if (ctx.params.id !== '~') {
            ctx.status = 403
            ctx.body = { error: 'forbidden' }
            return
        }
    }

    const dais = await ctx.db.collection('dais').findOne(
      ctx.params.id === '~'
        ? { user: ctx.token.user }
        : { _id: ctx.params.id }
    )

    if (!dais) {
        ctx.status = 404
        ctx.body = { error: 'not found' }
        return
    }

    // inject user account state
    const user = await ctx.db.collection('user').findOne(
        { _id: dais.user },
        { hash: false, salt: false, iter: false }
    )

    dais.account_active = Boolean(user && user.active)

    ctx.dais = dais
    if (next) await next()
}

const Route_GetDaisById = async ctx => {
    await Dais(ctx),
    ctx.status = 200
    ctx.body = toId(ctx.dais)
}

route.get('/daises/',
    AccessFilter('admin', 'academic_director'),
    async ctx => {
        const daises = await ctx.db.collection('dais').find(
            {},
            { name: true, user: true, session: true, photoId: true, school: true, contact: true }
        ).toArray()
        ctx.status = 200
        ctx.body = daises.map(toId)
    }
)

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

route.post('/daises/:id',
    AccessFilter('academic_director', 'admin'),
    Dais,
    async ctx => {
        const {
            activate,
            deactivate,
            session
        } = getPayload(ctx)

        if (!activate && !deactivate && !session) {
            ctx.status = 400
            ctx.body = { error: 'no action' }
            return
        }

        const { _id, user } = ctx.dais

        if (session !== undefined) {
            await Sessions(ctx)
            const targetSession = ctx.sessions.find(sess => sess._id === session)
            if (!targetSession) {
                ctx.status = 400
                ctx.body = { error: 'no such session' }
                return
            }
            await ctx.db.collection('dais').updateOne(
                { _id: _id },
                { $set: {
                    session: targetSession._id,
                    role: '主席-' + targetSession.name,
                    last_modified: new Date()
                } }
            )
            await ctx.db.collection('user').updateOne(
                { _id: user },
                { $set: {
                    access: ['dais'],
                    session: targetSession._id
                } }
            )
            // continue to activate / deactivate, do not end handler
        }

        if (activate) {
            await ctx.db.collection('user').updateOne(
                { _id: user },
                { $set: {
                    active: true,
                    access: ['dais']
                } }
            )
        }

        if (deactivate) {
            await ctx.db.collection('user').updateOne(
                { _id: user },
                { $set: {
                    active: false,
                    access: []
                } }
            )
        }

        await Route_GetDaisById(ctx)
    }
)

route.delete('/daises/:id',
    AccessFilter('academic_director', 'admin'),
    Dais,
    async ctx => {
        await ctx.db.collection('dais').deleteOne({ _id: ctx.dais._id })
        await ctx.db.collection('user').updateOne(
            { _id: ctx.dais.user },
            { $set: { active: false, access: [] } }
        )
        ctx.status = 200
        ctx.body = { message: 'nuked' }
    }
)

module.exports = {
    routes: route.routes()
}
