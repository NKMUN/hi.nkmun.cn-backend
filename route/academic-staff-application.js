const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const getPayload = require('./lib/get-payload')
const { Config } = require('./config')
const { toId, newId } = require('../lib/id-util')

async function IsSelfOrAdmins(ctx, next) {
    if (!await AccessFilter('transient.academic-staff.apply', 'admin', 'academic-director')(ctx)) {
        return
    }

    if (!ctx.hasAccessTo('admin') && !ctx.hasAccessTo('academic-director')) {
        if (ctx.token.user !== ctx.params.user) {
            ctx.status = 403
            ctx.body = { error: 'forbidden' }
            return
        }
    }

    if (next)
        await next()
}

route.get('/academic-staff-applications/user/:user',
    IsSelfOrAdmins,
    async ctx => {
        const application = await ctx.db.collection('academic_staff').findOne({ user: ctx.params.user })
        if (application) {
            ctx.status = 200
            ctx.body = toId(application)
        } else {
            ctx.status = 404
            ctx.body = {}
        }
    }
)

route.patch('/academic-staff-applications/user/:user',
    IsSelfOrAdmins,
    async ctx => {
        const payload = getPayload(ctx)
        // strip id, _id
        delete payload.id
        delete payload._id

        const application = await ctx.db.collection('academic_staff').findOne({ user: ctx.params.user }, { _id: 1 })
        if (application) {
            await ctx.db.collection('academic_staff').updateOne(
                { _id: application._id },
                { $set: {
                    ...payload,
                    user: ctx.params.user
                } }
            )
            ctx.status = 200
            ctx.body = toId(await ctx.db.collection('academic_staff').findOne({ _id: application._id }))
        } else {
            const _id = newId()
            await ctx.db.collection('academic_staff').insertOne({
                _id,
                ...payload,
                user: ctx.params.user
            })
            ctx.status = 201
            ctx.body = toId(await ctx.db.collection('academic_staff').findOne({ _id }))
        }
    }
)


module.exports = {
    routes: route.routes()
}