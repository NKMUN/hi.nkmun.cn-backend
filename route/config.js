const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { Sessions } = require('./session')
const { LogOp } = require('../lib/logger')
const getPayload = require('./lib/get-payload')
const { Mailer } = require('./mailer')

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
        ctx.body.mailer = ctx.POSTIE ? 'postie' : 'internal'
    }
)

route.get('/config/config',      ReturnConfig('config') )
route.get('/config/application', ReturnConfig('application') )
route.get('/config/mail',        AccessFilter('admin'), ReturnConfig('mail') )

route.post('/config/mail',
    AccessFilter('admin'),
    Mailer,
    async ctx => {
        const { action } = ctx.query
        const { args } = getPayload(ctx)
        switch (action) {
            case 'test':
                if (!args || !String(args).includes('@')) {
                    ctx.status = 400
                    ctx.body = { message: 'args: bad email address' }
                    return
                }

                const {
                    success,
                    error,
                    transportResponse
                } = await ctx.mailer.sendMail({
                    to: args,
                    subject: 'Hi.NKMUN Email Delivery Test',
                    html: `This is a test email to: ${args}`
                })

                if (success) {
                    ctx.status = 200
                    ctx.body = { message: 'mail scheduled' }
                } else {
                    ctx.status = 503
                    ctx.body = { message: (error ? error.toString() : '') + ', ' + (transportResponse || '') }
                }
                return
        }
        ctx.status = 400
        ctx.body = { message: 'no operation specified' }
    }
)

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
