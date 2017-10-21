const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { Sessions } = require('./session')
const { LogOp } = require('../lib/logger')
const getPayload = require('./lib/get-payload')

async function Config(ctx, next) {
    ctx.config = await ctx.db.collection('meta').findOne({ _id: 'config' }, { _id: 0 })
    if (next)
        await next()
}

function ReturnConfig(id) {
    return async function ReturnConfig(ctx) {
        ctx.status = 200
        ctx.body = (await ctx.db.collection('meta').findOne({ _id: id }, { _id: 0 })) || {}
    }
}

route.get('/config',
    Config,
    async ctx => {
        ctx.status = 200
        ctx.body = ctx.config || {}
        ctx.body.sessions = await ctx.db.collection('session').aggregate([
            { $project: {
                _id:   0,
                id:   '$_id',
                type: '$type',
                name: '$name',
                dual: { $ifNull: ['$dual', false] },
                reserved: { $ifNull: ['$reserved', false] },
                requiresChairman: { $ifNull: ['$requiresChairman', false] },
                exchangeable: { $ifNull: ['$exchangeable', true] },
            } }
        ]).toArray()
    }
)

route.get('/config/config',      ReturnConfig('config') )
route.get('/config/application', ReturnConfig('application') )
route.get('/config/mail',        AccessFilter('admin'), ReturnConfig('mail') )

route.put('/config/:id',
    AccessFilter('admin'),
    LogOp('config', 'write'),
    async ctx => {
        let payload = getPayload(ctx)
        await ctx.db.collection('meta').update(
            { _id: ctx.params.id }, { $set: payload }, { upsert: true }
        )
        ctx.status = 200
        ctx.body = payload
    }
)

module.exports = {
    Config,
    routes: route.routes()
}
